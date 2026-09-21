/**
 * Intent — the canonical query-understanding object — and the conversation state that merges
 * successive turns into it.
 *
 * Contracts: API_CONTRACT §7.1 (shape, verbatim field list and example) and §7
 * (`POST /ai/v1/query/understand` → `Intent`; `POST /ai/v1/search` consumes it).
 * Spec §8 Query Understanding is the governing rule: 「必须允许不确定字段。不要强行猜测。」 —
 * every uncertain field is therefore `T | null` and **no field carries a default value**.
 * Spec §34 Conversation System fixes what state must survive across turns.
 */

import type {
  BudgetUnit,
  IntentKind,
  IntentUnknownField,
  LocationRefType,
  Polarity,
  SortPreference,
  TimeRefType,
  UrgencyLevel,
} from "./enums.js";
import type { GeoPoint, IsoDateTime, Locale, Nullable, Uuid } from "./common.js";

/* `IntentKind`, `LocationRefType`, `TimeRefType`, `BudgetUnit`, `SortPreference`, `UrgencyLevel`
 * are declared once in `enums.ts` and imported here (and star-exported from `index.ts`). */

/** `preferences[].polarity` — API_CONTRACT §7.1 (`1` = want, `-1` = avoid). */
export type PreferencePolarity = Polarity;

/**
 * `Intent.location` — API_CONTRACT §7.1:
 * `{ "type":"district", "value":"Sha Tin", "resolved": {lat,lng}, "radius_m": null }`.
 * `resolved` is null until the resolver ran; `radius_m` null means "user never said" (never
 * defaulted, spec §8).
 */
export interface LocationRef {
  /** Reference kind — see {@link LocationRefType}. */
  type: LocationRefType;
  /** Raw text the user produced, before resolution. */
  value: string | null;
  /** Resolved coordinate; null when unresolved or when the user declined precise geo (AGENT_CONTRACT §1 `location`). */
  resolved: Nullable<GeoPoint>;
  /** Search radius in metres; null = unspecified, **not** "unbounded". */
  radius_m: Nullable<number>;
  /** Tenant district/area code — V1 `locations.area` (`NT|KLN|HKI`). */
  area?: Nullable<string>;
  /** Confidence in this specific resolution; also mirrored into {@link Intent.confidence}.location. */
  confidence?: Nullable<number>;
}

/**
 * `Intent.time` — API_CONTRACT §7.1:
 * `{ "type":"explicit", "starts_at":"2026-09-26T19:00:00Z", "ends_at":null }`.
 * `ends_at` null means an open-ended instant, not "no end".
 */
export interface TimeRef {
  /** Reference kind — see {@link TimeRefType}. */
  type: TimeRefType;
  /** Window start in UTC; null when the user gave no time at all. */
  starts_at: Nullable<IsoDateTime>;
  /** Window end in UTC; null when open-ended. */
  ends_at: Nullable<IsoDateTime>;
  /** Original phrase, e.g. `"周六晚上"` — kept so copy can echo the user's words (AGENT_CONTRACT §12). */
  raw?: Nullable<string>;
  /** IANA zone the phrase was interpreted in — V1 `tenants.timezone` (AGENT_CONTRACT §12 `Asia/Hong_Kong`). */
  timezone?: string;
}

/**
 * `Intent.budget` — API_CONTRACT §7.1: `{min:null, max:500, currency:"HKD", per:"party"}`.
 * Amounts are plain numbers here (the parsed unit is HKD-scale) but the card layer renders
 * {@link Price}, which is a string decimal — keep the two in sync via the fact layer.
 */
export interface BudgetRef {
  /** Lower bound; null when unstated. */
  min: Nullable<number>;
  /** Upper bound; null when unstated. */
  max: Nullable<number>;
  /** ISO-4217 code — AGENT_CONTRACT §12 default `HKD`. */
  currency: string;
  /** What the bound applies to — see {@link BudgetUnit}. */
  per: Nullable<BudgetUnit>;
}

/** A soft preference term. Source: API_CONTRACT §7.1 `preferences[]` (`{key,value,polarity}`). */
export interface PreferenceTerm {
  /** Snake_case key, e.g. `ambience`, `cuisine`. */
  key: string;
  /** Term value, e.g. `quiet`. */
  value: string;
  /** `1` wants it, `-1` avoids it — API_CONTRACT §7.1. */
  polarity: PreferencePolarity;
  /** Per-term confidence; mirrored into {@link Intent.confidence} when material. */
  confidence?: Nullable<number>;
  /** Turn index that introduced the term — spec §34 state merge audit trail. */
  introduced_at_turn?: number;
}

/** A hard constraint (dietary, accessibility, budget ceiling). Source: API_CONTRACT §7.1 `constraints[]` (`{key,value}`). */
export interface ConstraintTerm {
  /** Snake_case key, e.g. `cuisine_avoid`, `no_pork` (V1 `offerings.constraints`). */
  key: string;
  /** Value term, e.g. `spicy`. */
  value: string;
  /** Optional machine-checkable expression, e.g. `{max_party: 4}`. */
  expression?: Record<string, unknown> | null;
}

/**
 * The canonical query-understanding object. **Source: API_CONTRACT §7.1**, produced by
 * `POST /ai/v1/query/understand` (API §7) by the `user_intent` planner agent (AGENT §1), which
 * 「may not invent location/budget/party_size」 — hence the nullables and {@link unknowns}.
 */
export interface Intent {
  /** Verbatim user text — API_CONTRACT §7.1 `raw_query`. */
  raw_query: string;
  /** Classified intent; `unknown` when nothing could be trusted — §7.1. */
  intent: IntentKind;
  /** Category slug (`restaurant`); **null when not stated** — API_CONTRACT §7.1 comment. */
  category: Nullable<string>;
  /** Location block; null when the user said nothing about place. */
  location: Nullable<LocationRef>;
  /** Time block; null when the user said nothing about when. */
  time: Nullable<TimeRef>;
  /** Budget block; null when the user gave no number. Never seeded with the tenant average. */
  budget: Nullable<BudgetRef>;
  /** Party size; **null** in the §7.1 example — asking is the correct behaviour, guessing is not. */
  party_size: Nullable<number>;
  /** Soft preferences — API_CONTRACT §7.1 `preferences`. */
  preferences: PreferenceTerm[];
  /** Hard constraints — API_CONTRACT §7.1 `constraints`. */
  constraints: ConstraintTerm[];
  /** Ordering preference; defaults to `relevance` only because that is the neutral option (§7.1). */
  sort_preference: SortPreference;
  /** Time pressure; null when the user expressed none. */
  urgency: Nullable<UrgencyLevel>;
  /** Locale of the query — API_CONTRACT §7.1 `language`, AGENT §12 (answer must echo it). */
  language: Locale;
  /**
   * Per-field confidence map, e.g. `{category:0.95, budget:0.9, time:0.8}` — API_CONTRACT §7.1.
   * Keys are the intent field names; values 0..1. Below 0.6 the copy must hedge and below 0.4 the
   * field must be dropped with a handoff offer (AGENT_CONTRACT §4).
   */
  confidence: Record<string, number>;
  /**
   * Field names the extractor could not fill and must ask about, e.g. `["party_size"]` —
   * API_CONTRACT §7.1 (`§8 — never guess; ask in one follow-up only`).
   * Invariant checked by `scripts/validate_conformance.mjs`: a name listed here must be null or
   * absent in the same object.
   */
  unknowns: string[];
  /** Follow-up already asked about these unknowns (spec §8 allows exactly one). */
  clarification_asked?: boolean;
  /** Conversation this intent belongs to — API_CONTRACT §7 `conversation_id`. */
  conversation_id?: Nullable<Uuid>;
  /** Turn sequence inside the conversation — spec §34. */
  turn?: number;
  /** Which provider produced this intent; `mock` must be shown as such (DECISIONS D4). */
  provider?: string | null;
  /** Extractor/model name for eval tracing — V1 `llm_calls.model`. */
  model?: string | null;
  /** Wall-clock cost of extraction, for the §160 cost roll-up. */
  latency_ms?: number | null;
}

/** Field names of {@link Intent} that may be listed in {@link Intent.unknowns} — see
 * `INTENT_UNKNOWN_FIELD` in `enums.ts` (API_CONTRACT §7.1 `unknowns`). */

/** `POST /ai/v1/query/understand` request body (API_CONTRACT §7). */
export interface QueryUnderstandRequest {
  /** Natural-language query. */
  query: string;
  /** Runtime context the extractor may use (geo/now/locale/party_size) — API_CONTRACT §7 `/ai/v1/chat` context. */
  context: RequestContext;
  /** Existing intent to refine — spec §34 multi-turn merge. */
  previous_intent?: Nullable<Intent>;
  /** Conversation id for memory lookup — API_CONTRACT §7. */
  conversation_id?: Nullable<Uuid>;
}

/**
 * Request context that accompanies AI calls.
 * **Source: API_CONTRACT §7** `{query, conversation_id?, context:{geo, now, locale, party_size}}`.
 */
export interface RequestContext {
  /** Coarse or precise origin, only with consent (AGENT_CONTRACT §1/§10). */
  geo: Nullable<GeoPoint>;
  /** Server time used to resolve relative dates — AGENT_CONTRACT §12 timezone. */
  now: IsoDateTime;
  /** Locale of the user — API_CONTRACT §7.1 `language`. */
  locale: Locale;
  /** Known party size from the session or profile; null when unknown. */
  party_size: Nullable<number>;
  /** Tenant slug — API_CONTRACT §1 `X-Tenant`. */
  tenant?: string;
  /** Device class for responsive copy — AGENT_CONTRACT §10 `context.device`. */
  device?: string;
  /** Geo precision actually permitted — AGENT_CONTRACT §10 `context.geo_precision`. */
  geo_precision?: string;
  /** Whether the caller consented to precise location (spec §50/§112). */
  location_consent?: boolean;
}

/**
 * Conversation state — what must persist across turns. **Source: spec §34** ("NEXUS 必须保持
 * conversation state / intent state / filters / preferences") and API_CONTRACT §7.1's merge
 * examples (`太贵了` → `budget.max *= 0.7`; `近一点` → `sort_preference=distance` + tightened
 * `location.radius_m`; `不吃辣` → append constraint), implemented in
 * `apps/ai/app/nlu/state_merger.py`. Persisted into V1 `conversations.state jsonb`.
 */
export interface ConversationState {
  /** Conversation row this state belongs to — V1 `conversations.id`. */
  conversation_id: Uuid;
  /** Monotonic turn counter — V1 `messages` ordering, spec §34. */
  turn: number;
  /** Current merged intent; null before the first understood query (never an empty guess). */
  intent: Nullable<Intent>;
  /** Last intent the user saw results for, so `太贵了` can be computed against it — spec §34. */
  previous_intent: Nullable<Intent>;
  /** Structured filters applied on top of intent — API_CONTRACT §7 `/ai/v1/search` `filters`. */
  filters: Record<string, unknown>;
  /** Session-scoped preferences merged from long-term memory — V1 `user_preferences.scope`. */
  preferences: PreferenceTerm[];
  /** Hard constraints accumulated across turns (e.g. `不吃辣`) — API_CONTRACT §7.1. */
  constraints: ConstraintTerm[];
  /** Entity ids currently on screen, so "把前三家比较一下" resolves (spec §37). */
  visible_entity_ids: Uuid[];
  /** Last recommendation set shown — V1 `recommendation_sets.id`, API §7 `/ai/v1/recommend`. */
  last_set_id: Nullable<Uuid>;
  /** Last agent run for this conversation — V1 `agent_runs.id`. */
  last_agent_run_id: Nullable<Uuid>;
  /** Pending question the AI asked, so it is asked at most once (spec §8). */
  pending_question: Nullable<string>;
  /** Unknowns already clarified, to avoid re-asking — API_CONTRACT §7.1 `unknowns`. */
  resolved_unknowns: string[];
  /** Handoff state, if the conversation left the AI (spec §26). */
  handoff: Nullable<{ reason: string; requested_at: IsoDateTime; resolved_at: Nullable<IsoDateTime> }>;
  /** Free-form memory slots (session tier only; long-term lives in `user_preferences`) — spec §117. */
  slots?: Record<string, unknown>;
  /** Last updated instant. */
  updated_at?: IsoDateTime;
}

/**
 * A single merge operation the state merger may apply. **Source: API_CONTRACT §7.1 merge rules.**
 * Kept as a typed union so the merger is auditable (AGENT_CONTRACT §8 audit) and so tests can
 * assert "太贵了" ⇒ `scale_budget_max` with factor `0.7`.
 */
export type StateMergeOp =
  | { op: "set"; path: string; value: unknown; confidence?: Nullable<number> }
  | { op: "scale_budget_max"; factor: number }
  | { op: "scale_budget_min"; factor: number }
  | { op: "tighten_radius"; factor: number }
  | { op: "set_sort_preference"; value: SortPreference }
  | { op: "append_preference"; term: PreferenceTerm }
  | { op: "append_constraint"; term: ConstraintTerm }
  | { op: "remove_constraint"; key: string }
  | { op: "clear"; path: string }
  | { op: "mark_unknown"; field: IntentUnknownField };

/** Documented merge factors from API_CONTRACT §7.1 (「太贵了」 → `budget.max *= 0.7`). */
export const BUDGET_RELAX_FACTOR = 0.7;
/** Documented radius tightening factor for 「近一点」 (API_CONTRACT §7.1: `location.radius_m` tightened). */
export const RADIUS_TIGHTEN_FACTOR = 0.5;
