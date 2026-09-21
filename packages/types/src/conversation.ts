/**
 * Conversations, messages and human handoff.
 *
 * Contract: API_CONTRACT §3 (`GET /me/conversations`), §7 (`POST /api/v1/conversations`
 * `{merchant_id?, channel, mode}` → conversation; `GET /conversations/{id}` → messages + state;
 * `POST /ai/v1/search/stream` SSE), §5 (`/merchant/conversations`, `/{id}/reply`, `/{id}/handoff-resolve`).
 * Tables: V1 `conversations` (448-463), `messages` (465-479), `handoffs` (481-490).
 * Spec: §24 Merchant AI Agent, §25 AI Customer Service, §26 Human Handoff, §34 Conversation System.
 * The merged turn state itself lives in {@link ConversationState} (`intent.ts`).
 */

import type {
  ConversationChannel,
  ConversationMode,
  ConversationStatus,
  HandoffReason,
  HandoffStatus,
  MessageContentType,
  MessageRole,
  SenderType,
} from "./enums.js";
import type { EntityCard } from "./card.js";
import type { CompareTable } from "./search.js";
import type { ConversationState } from "./intent.js";
import type { IsoDateTime, Nullable, Timestamps, Uuid } from "./common.js";

/* enum unions used below are declared in enums.ts */

/** A chat message. **Source: V1 `messages` (465-478).** */
export interface Message {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Parent conversation — V1 `conversation_id`. */
  conversation_id: Uuid;
  /** Who sent it (`user|ai_agent|merchant_user|system`) — V1 `sender_type`. */
  sender_type: SenderType;
  /** Sender row id; null for system — V1 `sender_id`. */
  sender_id: Uuid | null;
  /** Model role — V1 `role`. */
  role: MessageRole;
  /** Text content — V1 `content` (NOT NULL). */
  content: string;
  /** Renderer hint (`text|cards|comparison|form`) — V1 `content_type`, spec §35/§36/§37. */
  content_type: MessageContentType;
  /**
   * Structured UI blocks + sources — V1 `payload jsonb`.
   * Carries `EntityCard[]` for `cards`, a {@link CompareTable} for `comparison`,
   * retrieved `fact_ids`/`document_ids` for citations (API §7, AGENT §4).
   */
  payload: MessagePayload;
  /** Run that produced an AI message — V1 `agent_run_id`; joins to `agent_runs` (API §9 `/admin/ai/runs`). */
  agent_run_id: Uuid | null;
  /** Model confidence 0..1 for AI messages; below the floor the agent hands off — V1 `confidence`, AGENT §1/§4. */
  confidence: Nullable<number>;
  /** True when this message triggered a handoff — V1 `handoff`, spec §26. */
  handoff: boolean;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
  /** True when the message was replaced by a later edit row — V1 has no `updated_at`, edits append. */
  edited?: boolean;
}

/** Structured blocks a message may render. Source: V1 `messages.payload jsonb` comment ("structured UI blocks + sources", API §7). */
export interface MessagePayload {
  /** Cards to render (spec §35). */
  cards?: EntityCard[];
  /** Comparison table (spec §37). */
  comparison?: CompareTable | null;
  /** Form definition for `content_type:"form"` (e.g. reservation details, spec §34). */
  form?: Record<string, unknown> | null;
  /** Facts cited by the text — AGENT §4 renderer contract. */
  fact_ids?: Uuid[];
  /** Documents/chunks retrieved for the answer — AGENT §7 context pack. */
  citations?: Array<{ document_id: Uuid; chunk_id?: Uuid | null; source_uri?: string | null; quote?: string | null }>;
  /** Set id when the message carried results — API §7 `set_id`. */
  set_id?: Uuid | null;
  /** Provider label; `"mock"` must be shown in the UI badge (DECISIONS D4). */
  provider?: string | null;
  /** Handoff request embedded in the message (spec §26). */
  handoff_request?: Record<string, unknown> | null;
}

/** A conversation row. **Source: API_CONTRACT §7** (`POST /api/v1/conversations`), V1 (448-461). */
export interface Conversation extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid | null;
  /** Consumer; null for merchant-side or anonymous threads — V1 `user_id`. */
  user_id: Uuid | null;
  /** Merchant on the merchant-agent path — V1 `merchant_id`. */
  merchant_id: Uuid | null;
  /** `web|mcp|ucp|whatsapp|email` — V1 `channel`, API §10. */
  channel: ConversationChannel;
  /** `ai|human|hybrid` — V1 `mode`, spec §25/§26. */
  mode: ConversationMode;
  /** Subject line — V1 `subject`. */
  subject: string | null;
  /** Merged intent/filter state — V1 `state jsonb`, spec §34. */
  state: ConversationState | Record<string, unknown>;
  /** `open|handoff|closed|archived` — V1 `status`. */
  status: ConversationStatus;
  /** Last message time — V1 `last_message_at`; drives the inbox ordering (API §5). */
  last_message_at: IsoDateTime | null;
  /** Messages when the thread is fetched whole — API §7 `GET /conversations/{id}` "messages + state". */
  messages?: Message[];
  /** Open handoff, if any. */
  handoff?: Handoff | null;
  /** Unread counter for the inbox badge. */
  unread_count?: number;
}

/** `POST /api/v1/conversations` body (API_CONTRACT §7). */
export interface ConversationCreateRequest {
  /** Merchant thread; omit for a platform-wide assistant thread — API §7 `merchant_id?`. */
  merchant_id?: Uuid | null;
  /** Channel — API §7. */
  channel: ConversationChannel;
  /** Mode — API §7. */
  mode: ConversationMode;
  /** Optional subject — V1 `subject`. */
  subject?: string | null;
  /** First message to post. */
  first_message?: string | null;
}

/** `GET /api/v1/conversations/{id}` response (API_CONTRACT §7: "messages + state"). */
export interface ConversationDetail {
  /** Thread header. */
  conversation: Conversation;
  /** Ordered messages. */
  messages: Message[];
  /** Typed state; falls back to `{}` when the thread has no understood intent yet. */
  state: Nullable<ConversationState>;
  /** Cursor for older pages — API §1. */
  next_cursor: string | null;
}

/** A handoff record. **Source: V1 `handoffs` (481-490)**, spec §26, AGENT_CONTRACT §1
 * (`customer_service` "answer below confidence floor → handoff").
 */
export interface Handoff {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Conversation handed off — V1 `conversation_id`. */
  conversation_id: Uuid;
  /** Merchant that must answer — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** `low_confidence|user_request|policy|refund` — V1 `reason`. */
  reason: HandoffReason;
  /** `open|accepted|resolved|expired` — V1 `status`. */
  status: HandoffStatus;
  /** What the AI could not answer, with citations — V1 `evidence jsonb`. */
  evidence: Record<string, unknown>;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
  /** Resolved — V1 `resolved_at`. */
  resolved_at: IsoDateTime | null;
}

/** `POST /api/v1/merchant/conversations/{id}/reply` body (API_CONTRACT §5, permission `send_message`). */
export interface MerchantReplyRequest {
  /** Text reply — V1 `messages.content`. */
  message: string;
  /** Structured blocks to attach (e.g. an updated card). */
  payload?: MessagePayload;
  /** Closes the handoff when replying to one. */
  resolve_handoff?: boolean;
}

/** `POST /api/v1/merchant/conversations/{id}/handoff-resolve` body (API_CONTRACT §5). */
export interface HandoffResolveRequest {
  /** Terminal status — V1 `handoffs.status` (`resolved|expired`). */
  status: Extract<HandoffStatus, "resolved" | "expired">;
  /** Resolution note, kept as evidence — V1 `evidence`. */
  note?: string | null;
}
