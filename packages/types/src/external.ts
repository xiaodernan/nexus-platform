/**
 * External agent surfaces: UCP capability profiles and the MCP server contract.
 *
 * Contract: API_CONTRACT §10 —
 *  - `GET /api/v1/merchants/{slug}/.well-known/ucp` → capability profile
 *    `{version, capabilities[], endpoints[], payment_handlers[]}`, served from `agent_profiles`
 *    **via `UcpAdapter` only**; business code must not build UCP JSON.
 *  - `/mcp` (streamable HTTP + JSON-RPC) exposing `search_nexus, get_merchant, search_products,
 *    check_availability, create_cart, create_reservation, get_order_status`; every call
 *    authenticates an `external_principals` row, checks scopes, and writes `agent_runs` +
 *    `audit_logs`.
 * Tables: V1 `agent_profiles` (919-931), `external_principals` (933-946).
 * Spec: §43 UCP Compatibility, §44 MCP Compatibility, §45 External Agent Strategy, §149 agent-to-agent commerce.
 * AGENT_CONTRACT §3 supplies the tool schema rules (`additionalProperties=false`).
 */

import type { JsonSchema } from "./json-schema.js";
import type { JsonRpcErrorCode, McpToolName, UcpCapability } from "./enums.js";
import type { EntityCard } from "./card.js";
import type { Intent } from "./intent.js";
import type { PermissionGrant, ToolSpec } from "./tools.js";
import type { AvailabilitySlot, MerchantProfile } from "./merchant.js";
import type { Cart, Order, Reservation } from "./commerce.js";
import type { IsoDateTime, Nullable, Uuid } from "./common.js";

/* enum unions used below are declared in enums.ts */

/** One declared UCP endpoint. Source: API_CONTRACT §10 `endpoints[]`. */
export interface UcpEndpoint {
  /** Endpoint path or absolute URL — e.g. `/api/v1/merchants/{slug}/ucp/search`. */
  path: string;
  /** HTTP method. */
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Human description for external agents. */
  description?: string | null;
  /** Request schema — same rule as tools: closed (`additionalProperties:false`, AGENT §3). */
  input_schema?: JsonSchema | null;
  /** Response schema, typically an `EntityCard` collection. */
  output_schema?: JsonSchema | null;
  /** Whether the endpoint mutates state and therefore needs an `Idempotency-Key` (API §1). */
  side_effect?: boolean;
  /** Whether a bearer token is required (API §3). */
  requires_auth?: boolean;
}

/** One declared payment handler. Source: API_CONTRACT §10 `payment_handlers[]`; V1 `payments.provider` vocabulary (spec §42: no card data stored). */
export interface UcpPaymentHandler {
  /** Handler id — `demo|stripe|alipayhk|payme|hsbc`. */
  id: string;
  /** Display name shown to the external agent's user. */
  name: string;
  /** Supported currencies — AGENT §12 default `HKD`. */
  supported_currencies: string[];
  /** Tokenised instrument type (`redirect|token|reference`). */
  instrument_type?: string | null;
  /** Endpoint that starts the flow. */
  endpoint?: string | null;
  /** Whether the handler is live (`demo` handlers must be labelled, DECISIONS D6). */
  live: boolean;
}

/**
 * Published UCP business profile. **Source: API_CONTRACT §10**; stored in V1
 * `agent_profiles.capabilities/payment_handlers` and serialised **only** by `UcpAdapter`.
 * "Google 当前 UCP 资料要求公开 profile，其中声明版本、能力、endpoint 和 payment handlers" (spec §43).
 */
export interface UcpProfile {
  /** Profile/protocol version — V1 `agent_profiles.version`, API §10 `version`. */
  version: string;
  /** Capability ids — see `UCP_CAPABILITY` in `enums.ts`. */
  capabilities: UcpCapability[];
  /** Callable endpoints — API §10 `endpoints[]`. */
  endpoints: UcpEndpoint[];
  /** Payment handlers — API §10 `payment_handlers[]`. */
  payment_handlers: UcpPaymentHandler[];
  /** Business identity block, derived from the merchant profile (never invented). */
  business?: {
    /** Merchant id — V1 `merchants.id`. */
    id: Uuid;
    /** Public slug used in the `.well-known` URL — API §10 `/{slug}/.well-known/ucp`. */
    slug: string;
    /** Legal name — V1 `legal_name`. */
    legal_name: string;
    /** Display name — V1 `display_name`. */
    display_name: string;
    /** Tenant slug — API §1. */
    tenant: string;
    /** Default currency — V1 `tenants.currency`. */
    currency: string;
    /** Default locale — AGENT §12. */
    locale: string;
  } | null;
  /** Contact for the operator of the profile — V1 `merchants.contact`. */
  contact?: Nullable<{ email: string | null; phone: string | null; site: string | null }>;
  /** Publication instant — V1 `agent_profiles.published_at`. */
  published_at?: IsoDateTime | null;
  /** Honesty marker: `true` when the profile serves seeded data (DECISIONS D6). */
  demo?: boolean;
}

/** An `agent_profiles` row before/after publishing. **Source: V1 `agent_profiles` (919-931)**, API §10. */
export interface AgentProfileRecord {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** `ucp|mcp|a2a` — V1 `protocol`. */
  protocol: string;
  /** Version — V1 `version`; `UNIQUE (merchant_id, protocol, version)`. */
  version: string;
  /** Base endpoint advertised to peers — V1 `endpoint`. */
  endpoint: string | null;
  /** Capability ids — V1 `capabilities jsonb`. */
  capabilities: UcpCapability[];
  /** Payment handler descriptors — V1 `payment_handlers jsonb`. */
  payment_handlers: UcpPaymentHandler[];
  /** `draft|published|revoked` — V1 `status`. */
  status: string;
  /** Publication — V1 `published_at`. */
  published_at: IsoDateTime | null;
  /** Created — V1 `created_at`. */
  created_at?: IsoDateTime;
}

/** A registered external principal. **Source: V1 `external_principals` (933-946)**; API §10:
 * "Every call authenticates an `external_principals` row, checks scopes, and writes
 * `agent_runs` + `audit_logs`."
 */
export interface ExternalPrincipal {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** `ucp|mcp` — V1 `protocol`. */
  protocol: string;
  /** OAuth-style client id — V1 `client_id`; `UNIQUE (protocol, client_id)`. */
  client_id: string;
  /** Human name, e.g. `ChatGPT`, `Gemini` — V1 `name` comment. */
  name: string;
  /** Merchant restriction; null = platform-wide read — V1 `merchant_id` comment. */
  merchant_id: Uuid | null;
  /** Granted scopes — V1 `scopes text[]`. */
  scopes: string[];
  /** Hash of the client secret — V1 `key_hash`; the plaintext is never persisted (spec §131). */
  key_hash: string | null;
  /** `active|revoked` — V1 `status`. */
  status: string;
  /** Linked NEXUS account for user-attributed calls — V1 `linked_user_id`. */
  linked_user_id: Uuid | null;
  /** Last call — V1 `last_seen_at`. */
  last_seen_at: IsoDateTime | null;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
  /** Effective permission grants resolved for this principal — AGENT §8. */
  grants?: PermissionGrant[];
}

/**
 * MCP tool definition advertised over `/mcp`.
 * **Source: API_CONTRACT §10 + AGENT_CONTRACT §3.** Field names follow the MCP wire format for
 * this adapter (`inputSchema` is camelCase on the MCP protocol; NEXUS snake_case applies to
 * *data* keys — see the note on {@link McpToolDefinitionSnake}).
 */
export interface McpToolDefinition {
  /** Public tool name — `MCP_TOOL_NAME` in `enums.ts` (API §10 list). */
  name: McpToolName | (string & {});
  /** Description for the external agent's planner. */
  description: string;
  /** JSON Schema for arguments; `additionalProperties:false` (AGENT §3). */
  inputSchema: JsonSchema;
  /** JSON Schema for the result content. */
  outputSchema?: JsonSchema;
  /** Annotation block carried to MCP clients. */
  annotations?: {
    /** True for mutations (`create_cart`, `create_reservation`). */
    readOnlyHint?: boolean;
    /** True when the call may change state — AGENT §3 `side_effect`. */
    destructiveHint?: boolean;
    /** Requires an explicit user action in the same request — AGENT §8. */
    idempotentHint?: boolean;
  };
  /** Permission the acting principal must hold — AGENT §3 `ToolSpec.permission`. */
  permission?: string;
  /** Scopes required — API §10 `external_principals.scopes`. */
  scopes?: string[];
  /** Linked internal registry tool, when the MCP tool wraps one — AGENT §3. */
  tool_name?: string | null;
  /** Version tag — V1 `agent_profiles.version`. */
  version?: string;
}

/**
 * Snake_case projection of {@link McpToolDefinition} used by NEXUS-owned surfaces
 * (`GET /ai/v1/tools`, `agent_profiles.config`). Kept separate so the MCP wire shape stays
 * protocol-correct while every NEXUS payload remains snake_case (API §1).
 */
export interface McpToolDefinitionSnake {
  /** @see McpToolDefinition.name */
  name: McpToolName | (string & {});
  /** @see McpToolDefinition.description */
  description: string;
  /** @see McpToolDefinition.inputSchema */
  input_schema: JsonSchema;
  /** @see McpToolDefinition.outputSchema */
  output_schema?: JsonSchema;
  /** @see ToolSpec.permission */
  permission?: string;
  /** @see McpToolDefinition.scopes */
  scopes?: string[];
}

/** JSON-RPC 2.0 request envelope used on `/mcp` (API_CONTRACT §10 "streamable HTTP + JSON-RPC"). */
export interface JsonRpcRequest<P = unknown> {
  /** Protocol version — always `"2.0"`. */
  jsonrpc: "2.0";
  /** Request id; string or number; absent for notifications. */
  id?: string | number | null;
  /** Method name, e.g. `tools/list` or `tools/call`. */
  method: string;
  /** Parameters object. */
  params?: P;
}

/** JSON-RPC 2.0 error object. */
export interface JsonRpcError {
  /** One of the standard codes — `JSON_RPC_ERROR_CODE` in `enums.ts`. */
  code: JsonRpcErrorCode;
  /** Message localised for developers, not end users. */
  message: string;
  /** Structured detail; `Nexus` refusals put `permission`, `scope`, `request_id` here (API §1). */
  data?: Record<string, unknown>;
}

/** JSON-RPC 2.0 response envelope. */
export interface JsonRpcResponse<R = unknown> {
  /** @see JsonRpcRequest.jsonrpc */
  jsonrpc: "2.0";
  /** @see JsonRpcRequest.id */
  id: string | number | null;
  /** Present on success. */
  result?: R;
  /** Present on failure — mutually exclusive with `result`. */
  error?: JsonRpcError;
}

/** `tools/call` params for `/mcp`. Source: API_CONTRACT §10. */
export interface McpToolCallParams {
  /** Tool being called — {@link McpToolName}. */
  name: McpToolName | (string & {});
  /** Arguments object; validated against the tool's `inputSchema`. */
  arguments: Record<string, unknown>;
  /** Caller-supplied idempotency key for mutating tools — API §1. */
  idempotency_key?: string | null;
}

/** MCP content block returned by `tools/call`. */
export interface McpContentBlock {
  /** Block type; NEXUS returns `text` and `resource`/`json`-style text payloads. */
  type: "text" | "image" | "resource";
  /** Text body (serialised JSON for structured results). */
  text?: string;
  /** Image block: data URL or reference. */
  data?: string | null;
  /** MIME type for image/resource blocks. */
  mime_type?: string | null;
}

/** MCP `tools/call` result. */
export interface McpToolCallResult {
  /** Ordered content blocks. */
  content: McpContentBlock[];
  /** Structured result mirroring `outputSchema`. */
  structuredContent?: Record<string, unknown> | null;
  /** True when the tool ran but reported a domain failure. */
  isError?: boolean;
  /** Run written for audit — API §10 "writes `agent_runs`"; V1 `agent_runs.id`. */
  agent_run_id?: Uuid | null;
  /** Fact ids backing every number returned — AGENT §4. */
  fact_ids?: Uuid[];
}

/** Typed wrappers for the seven MCP tools advertised in API_CONTRACT §10. */
export interface McpToolResults {
  /** `search_nexus` → cards + understood intent (API §7 non-streaming search shape). */
  search_nexus: { items: EntityCard[]; intent: Intent | null; set_id: Nullable<Uuid>; degraded: boolean };
  /** `get_merchant` → public profile (API §4). */
  get_merchant: { merchant: MerchantProfile | null };
  /** `search_products` → offering cards (API §4 `/menu`). */
  search_products: { items: EntityCard[] };
  /** `check_availability` → live slots, never cached (API §4, AGENT §5). */
  check_availability: { slots: AvailabilitySlot[]; open: Nullable<unknown> };
  /** `create_cart` → cart row (API §6). */
  create_cart: { cart: Cart };
  /** `create_reservation` → reservation with code (API §6). */
  create_reservation: { reservation: Reservation };
  /** `get_order_status` → order status machine (API §6). */
  get_order_status: { order: Order | null; status: Nullable<string> };
}

/** Pairing of a public MCP tool with the internal registry spec it wraps (API §10, AGENT §3). */
export interface McpToolBinding {
  /** Public name. */
  mcp_tool: McpToolDefinition;
  /** Internal registry entry that actually executes — AGENT §3 `ToolSpec`. */
  tool_spec: ToolSpec;
  /** Minimum scopes the principal must carry. */
  required_scopes: string[];
}
