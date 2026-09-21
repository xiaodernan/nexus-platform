/**
 * Event schema — "single shape, one place".
 *
 * Contract: AGENT_CONTRACT §10 (verbatim object + required name list + dedupe rule) and
 * API_CONTRACT §7 (`/ai/v1/feedback`, `event: status` stream). Table: V1__init.sql `events`
 * (lines 762-781). Spec: §58 Event Tracking, §122 Real-time Events, §162 North Star Metric.
 *
 * Rules baked in here:
 *  - `event_id` (uuid) is the **dedupe key**; producers must retry safely (AGENT §10).
 *  - `actor_id` / `subject_id` are nullable, not omitted-with-default (V1 allows NULL).
 *  - the north-star derivation only counts a `search` followed within 30 min by a conversion
 *    event with `degraded=false` (AGENT §10, spec §162).
 */

import {
  NORTH_STAR_CONVERSION_EVENT,
  NORTH_STAR_WINDOW_MINUTES,
} from "./enums.js";
import type {
  ActorType,
  DeviceClass,
  EventName,
  EventSubjectType,
  GeoPrecision,
  NorthStarConversionEvent,
} from "./enums.js";
import type { IsoDateTime, JsonObject, Locale, Uuid } from "./common.js";

/* `EventName` (17 names, AGENT §10), `ActorType`, `EventSubjectType`, `GeoPrecision`,
 * `DeviceClass`, `NorthStarConversionEvent` are declared in `enums.ts`. */

/** Window (minutes) within which a conversion fulfils a search. AGENT_CONTRACT §10. */
export const NORTH_STAR_WINDOW = NORTH_STAR_WINDOW_MINUTES;

/**
 * Conversion events that count as "intent fulfilled" for `v_north_star`
 * (`reserve|purchase|favorite|share`). **Source: AGENT_CONTRACT §10** north-star derivation,
 * V1 view `v_north_star` (line 1024), spec §162.
 */
export const NORTH_STAR_CONVERSION_EVENTS: readonly NorthStarConversionEvent[] =
  NORTH_STAR_CONVERSION_EVENT;

/**
 * `Event.context` — device/locale/geo-precision envelope.
 * Source: AGENT_CONTRACT §10 (`{"locale":"zh-HK","device":"mobile","geo_precision":"district"}`)
 * and V1 `events.context jsonb` comment (device, locale, coarse geo, utm).
 */
export interface EventContext {
  /** User locale — AGENT §12. */
  locale?: Locale;
  /** Device class. */
  device?: DeviceClass | (string & {});
  /** Precision actually permitted for geo; precise values need consent (AGENT §1 `location`). */
  geo_precision?: GeoPrecision | (string & {});
  /** Coarse district/area label rather than coordinates. */
  district?: string | null;
  /** Marketing attribution params (spec §59). */
  utm?: { source?: string | null; medium?: string | null; campaign?: string | null; term?: string | null; content?: string | null };
  /** Referral code carried in the session — V1 `referrals.code`. */
  referral_code?: string | null;
  /** Client app version / build, for cohort analysis. */
  app_version?: string | null;
  /** Browser user agent (truncated) — V1 `audit_logs.user_agent`. */
  user_agent?: string | null;
  /** Anything else the producer carries; snake_case keys (API_CONTRACT §1). */
  [key: string]: unknown;
}

/**
 * The one event shape. **Source: AGENT_CONTRACT §10.**
 * Written to V1 `events` via the `record_event` tool (AGENT §3) and the `POST /api/v1/events`
 * ingest path (API §0 events ownership).
 */
export interface Event {
  /** Event name — AGENT §10 `name`. */
  name: EventName;
  /** Client- or server-generated instant (UTC) — AGENT §10 `occurred_at`; V1 `occurred_at`. */
  occurred_at: IsoDateTime;
  /** Tenant scope — AGENT §10 `tenant_id`; V1 `events.tenant_id` (nullable on the table). */
  tenant_id: Uuid | null;
  /** Who acted — AGENT §10 `actor_type`. */
  actor_type: ActorType;
  /** Actor id; null for anonymous (AGENT §10 `actor_id: "uuid|null"`). */
  actor_id: Uuid | null;
  /** Subject kind; null for request-level events such as `search` (AGENT §10). */
  subject_type: EventSubjectType | null;
  /** Subject id; null when the subject is a query, not a row (AGENT §10). */
  subject_id: Uuid | null;
  /** Anonymous/browser session id — AGENT §10 `session_id`; V1 `events.session_id`. */
  session_id: string | null;
  /** Conversation the event happened in — AGENT §10 `conversation_id`. */
  conversation_id: Uuid | null;
  /** Event-specific payload; keys snake_case (API §1). AGENT §10 `properties: {}`. */
  properties: JsonObject;
  /** Device/locale/geo envelope — AGENT §10 `context`. */
  context: EventContext;
  /**
   * Dedupe key, uuid. **Required on ingest**; V1 `events.event_id UNIQUE DEFAULT gen_random_uuid()`,
   * so a retried producer must resend the same `event_id` (AGENT §10 "producers must retry safely").
   */
  event_id?: Uuid;
  /** Server-assigned bigserial row id — V1 `events.id`; present on read-back only. */
  id?: string;
  /** Ingest instant — V1 `events.ingest_at`. */
  ingest_at?: IsoDateTime;
  /** Correlates to `agent_runs` and `audit_logs` — API §1 `X-Request-Id`. */
  request_id?: string | null;
  /** Whether the producing AI path degraded; north-star ignores `degraded:true` (AGENT §10). */
  degraded?: boolean;
}

/** Minimal event as a client may submit it (server fills ids/tenant/ingest time). */
export type EventInput = Pick<Event, "name" | "properties"> &
  Partial<Omit<Event, "name" | "properties" | "id">>;

/** `POST /ai/v1/feedback` body. Source: API_CONTRACT §7 (spec §99). Table: V1 `feedback_events` (601-613). */
export interface FeedbackEvent {
  /** What the signal is about — V1 `subject_type` (see `FeedbackSubjectType` in `enums.ts`). */
  subject_type: string;
  /** Subject row id; null for set-level feedback — V1 `subject_id`. */
  subject_id: Uuid | null;
  /** Signal name — V1 `feedback_events.signal`; spec §99. */
  signal: string;
  /** Extra structured value — V1 `value jsonb` (e.g. `{"reason":"too_expensive"}`). */
  value: JsonObject;
  /** Channel the signal arrived on — V1 `channel` default `web`. */
  channel?: string;
  /** Session for anonymous signals — API §7 `session_id`. */
  session_id?: string | null;
  /** Tenant — V1 `tenant_id`. */
  tenant_id?: Uuid | null;
  /** User — V1 `user_id`. */
  user_id?: Uuid | null;
}

/** Response to a feedback post; confirms whether the signal is weight-eligible (AGENT §6: min 3 signals before EMA moves weights). */
export interface FeedbackAck {
  /** Stored row id. */
  id: Uuid;
  /** Whether personalisation weights were updated by this signal. */
  applied: boolean;
  /** Signals observed for this subject/user so far. */
  signal_count: number;
  /** Minimum required before weights move — AGENT_CONTRACT §6. */
  min_signals_for_learning: number;
}

/** Minimum explicit signals before EMA updates personalisation weights. AGENT_CONTRACT §6. */
export const MIN_SIGNALS_FOR_LEARNING = 3;
