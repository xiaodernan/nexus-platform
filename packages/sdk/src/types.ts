/**
 * Shared wire types for the NEXUS SDK.
 *
 * Everything here mirrors `docs/API_CONTRACT.md`: JSON is snake_case, money is a
 * string decimal + currency code, timestamps are ISO-8601 UTC, lists are cursor
 * paged and errors always use the `{ error: { ... } }` envelope (contract §1).
 *
 * These types are intentionally structural (not exhaustive) — the API is the
 * source of truth, so unknown extra fields are tolerated via `Record`s where the
 * contract does not pin an exact shape.
 */

/** HTTP verbs used across the platform + AI surfaces. */
export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "HEAD" | "OPTIONS";

/** Query-string value types accepted by {@link QueryParams}. */
export type QueryValue = string | number | boolean | null | undefined | Date | ReadonlyArray<string | number | boolean | null | undefined>;

/** Query parameters; `undefined` entries are dropped. */
export type QueryParams = Record<string, QueryValue>;

/** Free-form JSON value. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** Error codes from contract §1. Unknown server codes are preserved as strings. */
export type ErrorCode =
  | "validation_error"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "ai_unavailable"
  | "internal"
  | "network_error"
  | "aborted"
  | "timeout"
  | (string & {});

/** The always-present error envelope (contract §1). */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, Json>;
    request_id?: string;
  };
}

/** Cursor pagination envelope returned by every list endpoint (contract §1). */
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  total_estimate?: number | null;
}

// ---------------------------------------------------------------------------
// Core shared objects (contract §2)
// ---------------------------------------------------------------------------

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Money {
  amount: string;
  currency: string;
}

/** Source hierarchy for trust resolution (AGENT_CONTRACT §4). */
export type FactSource = "merchant" | "imported" | "observed" | "third_party" | "inferred";

export interface Fact {
  fact_id: string;
  subject_type: string;
  subject_id: string;
  attribute: string;
  value: Json;
  source: FactSource;
  confidence: number;
  observed_at?: string;
  expires_at?: string;
  stale?: boolean;
}

/** Demo/verification flags (DECISIONS D6). `flags.demo` must never be mistaken for real data. */
export interface EntityFlags {
  sponsored?: boolean;
  demo?: boolean;
  unverified?: boolean;
  [key: string]: boolean | undefined;
}

/** The single render contract shared by consumer + AI + MCP surfaces (contract §2). */
export interface EntityCard {
  card_type: "merchant" | "product" | "service" | "experience" | "collection" | string;
  id: string;
  slug?: string;
  title: string;
  subtitle?: string;
  price?: Money & { model?: string };
  flags?: EntityFlags;
  facts?: Fact[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Auth & account (contract §3)
// ---------------------------------------------------------------------------

export interface AuthSession {
  user: Record<string, unknown>;
  access_token: string;
  refresh_token: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

// ---------------------------------------------------------------------------
// Intent / AI (contract §7, §7.1)
// ---------------------------------------------------------------------------

export interface Intent {
  raw_query: string;
  intent: string;
  category?: string | null;
  location?: Record<string, unknown> | null;
  time?: Record<string, unknown> | null;
  budget?: Record<string, unknown> | null;
  party_size?: number | null;
  preferences?: Array<Record<string, unknown>>;
  constraints?: Array<Record<string, unknown>>;
  sort_preference?: string;
  urgency?: string;
  language?: string;
  confidence?: Record<string, number>;
  unknowns?: string[];
  [key: string]: unknown;
}

/** Deterministic hybrid search result (contract §7). `degraded:false` on the happy path. */
export interface AiSearchResult {
  items: EntityCard[];
  facets?: Record<string, unknown>;
  took_ms?: number;
  strategy?: string;
  degraded?: boolean;
  [key: string]: unknown;
}

export type AiStreamEventType = "status" | "intent" | "results" | "summary" | "done" | "error" | "degraded";

/** A parsed SSE frame from the AI search stream, plus the SDK's synthetic `degraded` event. */
export type AiStreamEvent =
  | { type: "status"; stage: string; text: string }
  | { type: "intent"; data: Intent }
  | { type: "results"; set_id?: string; items: EntityCard[] }
  | { type: "summary"; text: string; citations?: string[] }
  | { type: "done"; agent_run_id?: string; latency_ms?: number; cost_usd?: number; degraded: boolean }
  | { type: "error"; code?: string; message?: string; request_id?: string; data?: Record<string, unknown> }
  | {
      type: "degraded";
      degraded: true;
      /** What the SDK fell back to. `server` means the response was flagged `X-Nexus-Degraded`. */
      via: "deterministic_search" | "server";
      /** Why the primary path failed (message / event code). */
      reason: string;
      /** Deterministic results, when the fallback call succeeded. */
      result?: AiSearchResult;
      /** The original failure, never swallowed. */
      cause?: { code?: string; status?: number; request_id?: string; message?: string };
    };

// ---------------------------------------------------------------------------
// Events (AGENT_CONTRACT §10) — one shape, one place
// ---------------------------------------------------------------------------

export type ActorType = "user" | "merchant_user" | "agent" | "system" | "anonymous";

/** Event names every producer may emit (AGENT_CONTRACT §10). */
export type EventName =
  | "search"
  | "view"
  | "click"
  | "favorite"
  | "compare"
  | "reserve"
  | "cart_add"
  | "checkout"
  | "purchase"
  | "cancel"
  | "review"
  | "share"
  | "feedback"
  | "ai_answer"
  | "handoff"
  | "campaign_publish"
  | "agent_run";

export interface EventContext {
  locale?: string;
  device?: string;
  geo_precision?: string;
  [key: string]: Json | undefined;
}

/** An event as tracked by callers: `event_id`/`occurred_at`/`tenant_id` may be filled in by the SDK. */
export interface TrackEventInput {
  event_id?: string;
  name: EventName | (string & {});
  occurred_at?: string;
  tenant_id?: string;
  actor_type?: ActorType;
  actor_id?: string | null;
  subject_type?: string | null;
  subject_id?: string | null;
  session_id?: string;
  conversation_id?: string | null;
  properties?: Record<string, Json>;
  context?: EventContext;
}

/** The canonical wire shape POSTed to `/api/v1/events` (AGENT_CONTRACT §10). */
export interface TrackedEvent extends Required<Pick<TrackEventInput, "event_id" | "name" | "occurred_at">> {
  tenant_id?: string;
  actor_type?: ActorType;
  actor_id?: string | null;
  subject_type?: string | null;
  subject_id?: string | null;
  session_id?: string;
  conversation_id?: string | null;
  properties?: Record<string, Json>;
  context?: EventContext;
}
