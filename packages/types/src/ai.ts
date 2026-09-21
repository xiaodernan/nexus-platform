/**
 * AI service request/response shapes and the SSE stream contract.
 *
 * Contract: API_CONTRACT §7. The SSE turn is `POST /ai/v1/search/stream` (D13), the deterministic
 * fallback is `POST /ai/v1/search`, and `/api/v1/ai/**` does not exist on any service.
 * verbatim SSE event listing), §0 (the AI service owns query understanding, hybrid search, RAG,
 * orchestration, recommendations, comparison, eval, observability), §11 (NFRs: first stream event
 * < 1.2s, full answer < 6s, `/ai/v1/search` must never break even when the LLM is down).
 * Spec: §7 AI Search, §36 AI Result Interface, §105 AI Failure Handling, §116 AI Search Streaming.
 * AGENT_CONTRACT §1/§2 for the run metadata the `done` event carries.
 */

import type { AiStage, AiStreamEvent } from "./enums.js";
import type { EntityCard } from "./card.js";
import type { CompareTable, RecommendationSet, SearchQuery, SearchResponse } from "./search.js";
import type { Intent, RequestContext } from "./intent.js";
import type { ApiErrorEnvelope } from "./errors.js";
import type { AgentRun } from "./tools.js";
import type { IsoDateTime, Nullable, Uuid } from "./common.js";

/** SSE `event:` names — API_CONTRACT §7 stream (verbatim). Alias of the `enums.ts` union. */
export type AiStreamEventName = AiStreamEvent;
/* `AiStage` (`status` stage ids — API_CONTRACT §7 + spec §116) is imported from `enums.ts`. */

/** `POST /ai/v1/search/stream` body. **Source: API_CONTRACT §7**
 * (`{query, conversation_id?, context:{geo,now,locale,party_size}}` → SSE stream). */
export interface ChatRequest {
  /** Natural-language user message — API §7 `query`. */
  query: string;
  /** Existing thread for state merge; null for a fresh one (spec §34). */
  conversation_id: Nullable<Uuid>;
  /** Runtime context; `geo` null unless the user consented (AGENT §1). */
  context: RequestContext;
  /** Force the deterministic path — used by the client fallback and eval (API §1 failure ladder). */
  deterministic?: boolean;
  /** Client-generated key so the stream can be resumed/de-duplicated. */
  request_key?: string | null;
}

/** `POST /api/v1/ai/search` body — the non-streaming variant for MCP/UCP/API consumers (API §7). */
export interface AiSearchRequest extends Omit<SearchQuery, "context"> {
  /** Raw query when no intent was supplied — API §7. */
  query?: string | null;
  /** Context block. */
  context?: Partial<RequestContext>;
}

/**
 * One SSE frame. `event` is the stream name, `data` the parsed payload.
 * **Source: API_CONTRACT §7 event stream example.**
 */
export interface AiStreamFrame {
  /** Stream event name. */
  event: AiStreamEventName;
  /** SSE `id:` line, for resumable streams. */
  id?: string | null;
  /** Retry hint in ms emitted by the server. */
  retry_ms?: number | null;
  /** Decoded payload of the frame — see {@link AiStreamPayloads}. */
  data: AiStreamPayload;
}

/** Union of all frame payloads, keyed by event name. Source: API_CONTRACT §7. */
export type AiStreamPayload =
  | AiStatusEvent
  | AiIntentEvent
  | AiResultsEvent
  | AiSummaryEvent
  | AiDoneEvent
  | ApiErrorEnvelope;

/** `event: status` — `{"stage":"understanding","text":"理解需求…"}`. User-legible only; never chain of thought (spec §116). */
export interface AiStatusEvent {
  /** Pipeline stage. */
  stage: AiStage | (string & {});
  /** Localised status line shown to the user. */
  text: string;
  /** Optional progress 0..1 when the stage reports it. */
  progress?: Nullable<number>;
  /** Instant the stage started. */
  at?: IsoDateTime;
}

/** `event: intent` — `{Intent}` (API_CONTRACT §7). */
export interface AiIntentEvent {
  /** Understood intent; uncertain fields stay null (spec §8). */
  intent: Intent;
}

/** `event: results` — `{"set_id":"uuid","items":[EntityCard…]}` (API_CONTRACT §7). */
export interface AiResultsEvent {
  /** Set id for feedback joins — V1 `recommendation_sets.id`. */
  set_id: Uuid;
  /** Cards in display order. */
  items: EntityCard[];
  /** Facets for the filter rail — API §7 `/ai/v1/search`. */
  facets?: SearchResponse["facets"];
  /** Strategy used — AGENT §6. */
  strategy?: string | null;
}

/** `event: summary` — `{"text":"找到 8 个符合条件的选择","citations":[fact_id…]}` (API_CONTRACT §7). */
export interface AiSummaryEvent {
  /** Generated narrative; every number must match a retrieved fact or be stripped (AGENT §4, spec §72). */
  text: string;
  /** Fact ids cited by the summary. */
  citations: Uuid[];
  /** Review ids when the summary is about reviews (API §4 §55). */
  review_ids?: Uuid[];
  /** Claims removed by post-validation — V1 eval metric `hallucination_rate` (AGENT §4). */
  stripped_claim_count?: number;
}

/** `event: done` — `{"agent_run_id":"uuid","latency_ms":812,"cost_usd":0.0042,"degraded":false}` (API_CONTRACT §7). */
export interface AiDoneEvent {
  /** Run written for observability — V1 `agent_runs.id`; API §9 `/admin/ai/runs`. */
  agent_run_id: Uuid;
  /** Total latency ms — API §11 NFR (full answer < 6s). */
  latency_ms: number;
  /** Cost in USD — V1 `agent_runs.cost_usd`, spec §160. */
  cost_usd: number;
  /** Whether the response degraded to the deterministic path — API §1/§7. North-star ignores degraded answers (AGENT §10). */
  degraded: boolean;
  /** Provider that answered; `mock` must be badged (DECISIONS D4). */
  provider?: string | null;
}

/** Type map so a client can narrow a frame by its event name. Source: API_CONTRACT §7. */
export interface AiStreamPayloads {
  /** `status` frame. */
  status: AiStatusEvent;
  /** `intent` frame. */
  intent: AiIntentEvent;
  /** `results` frame. */
  results: AiResultsEvent;
  /** `summary` frame. */
  summary: AiSummaryEvent;
  /** `done` frame. */
  done: AiDoneEvent;
  /** `error` frame — the client must fall back to `POST /ai/v1/search` (API §7). */
  error: ApiErrorEnvelope;
}

/**
 * Full (non-streaming) AI search answer — the concatenation of the stream frames, returned by
 * `POST /api/v1/ai/search` (API_CONTRACT §7).
 */
export interface AiSearchResult {
  /** Understood intent for this query. */
  intent: Intent | null;
  /** Deterministic search block — same shape as `/ai/v1/search` (API §7). */
  search: SearchResponse;
  /** Recommendation set when the AI path composed one (API §7 `/ai/v1/recommend`). */
  recommendation: RecommendationSet | null;
  /** Comparison table when the intent was `compare` (API §7 `/ai/v1/compare`, spec §37). */
  comparison: CompareTable | null;
  /** Narrative summary + citations. */
  summary: AiSummaryEvent | null;
  /** Run metadata that the `done` frame would have carried. */
  done: AiDoneEvent;
  /** Full run record when the caller is entitled to see it (admin/eval). */
  agent_run?: AgentRun | null;
}

/** `POST /api/v1/merchant/ai-agent/chat` request — API_CONTRACT §7:
 * `{merchant_id, message, conversation_id}` → SSE; grounded **only** in the merchant KB,
 * low confidence → handoff (spec §24-§26). */
export interface MerchantAgentChatRequest {
  /** Merchant whose KB grounds the answer — API §7. */
  merchant_id: Uuid;
  /** Consumer message. */
  message: string;
  /** Thread id; null starts one (API §7 `conversation_id`). */
  conversation_id: Nullable<Uuid>;
  /** Runtime context for opening hours / availability wording. */
  context?: Partial<RequestContext>;
  /** Force handoff instead of answering (merchant-side debug). */
  force_handoff?: boolean;
}

/** A handoff proposal emitted when confidence falls below the floor (AGENT §1/§4, spec §26). */
export interface HandoffProposal {
  /** Reason recorded on V1 `handoffs.reason`. */
  reason: string;
  /** Conversation to hand over. */
  conversation_id: Uuid;
  /** Merchant that must answer. */
  merchant_id: Uuid;
  /** Question the AI could not answer, with its citations. */
  question: string;
  /** Confidence that triggered the escalation. */
  confidence: number;
}

/** Latency targets from API_CONTRACT §11 — asserted by the eval/perf gates (AGENT §11). */
export const AI_NFR = {
  /** p95 `/ai/v1/search` warm, ms. */
  search_p95_ms: 250,
  /** First SSE event for AI search, ms. */
  first_stream_event_ms: 1200,
  /** Full LLM answer, ms. */
  full_answer_ms: 6000,
} as const;
