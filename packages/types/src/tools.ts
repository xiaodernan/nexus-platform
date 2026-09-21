/**
 * Tool registry, plan/step, agent run and permission-grant types.
 *
 * Contract: AGENT_CONTRACT §3 (ToolSpec fields, verbatim from the Python example),
 * §2 (orchestrator loop + budgets), §8 (per-subject permissions),
 * API_CONTRACT §7 (`GET /ai/v1/tools` manifest). Tables: V1 `agent_runs` (801-829),
 * `permission_grants` (128-139). Spec: §10 Agent Orchestrator, §11 Tool System, §48-§52, §70.
 */

import type {
  AgentKind,
  AgentName,
  AgentRunStatus,
  CostClass,
  FallbackKind,
  PlanStepMode,
  ToolName,
  ToolScope,
} from "./enums.js";
import type { JsonSchema } from "./json-schema.js";
import type { IsoDateTime, JsonObject, Uuid } from "./common.js";

/* All of the unions imported above are declared once in `enums.ts` (AGENT_CONTRACT §1 roster,
 * §3 canonical tool names / cost classes / scopes, V1 `agent_runs` status columns). */

/** Per-tool timeout ceiling — AGENT_CONTRACT §2 rule 5 ("4s per tool"). */
export const TOOL_TIMEOUT_MS = 4_000;
/** Per-request timeout ceiling — AGENT_CONTRACT §2 rule 5 ("12s per request"). */
export const REQUEST_TIMEOUT_MS = 12_000;
/** Max tool calls per user-facing request — AGENT_CONTRACT §2 rule 2. */
export const MAX_TOOL_CALLS_PER_REQUEST = 6;
/** Max LLM calls per user-facing request — AGENT_CONTRACT §2 rule 2. */
export const MAX_LLM_CALLS_PER_REQUEST = 3;
/** Max reasoning-model calls per request — AGENT_CONTRACT §9. */
export const MAX_REASONING_CALLS_PER_REQUEST = 1;
/** Rerank window size — AGENT_CONTRACT §9 (`top-40 only`). */
export const RERANK_TOP_K = 40;
/** Chunk token target range — AGENT_CONTRACT §7 (240-400 tokens, 12% overlap). */
export const CHUNK_TOKEN_RANGE: readonly [number, number] = [240, 400];
/** Chunk overlap ratio — AGENT_CONTRACT §7. */
export const CHUNK_OVERLAP_RATIO = 0.12;
/** `search_web` hard cap — AGENT_CONTRACT §3. */
export const WEB_TOOL_TIMEOUT_MS = 10_000;

/**
 * Tool declaration. **Source: AGENT_CONTRACT §3** — the Python `ToolSpec(...)` example, field for
 * field. Tools are the *only* path from an agent to data (no prompt→DB, spec §52), and
 * `registry.dispatch(subject, tool, args)` runs: permission check → argument validation →
 * timeout/retry → execute → result validation → audit/log → return.
 */
export interface ToolSpec {
  /** Canonical tool name — AGENT §3 "implement exactly these". */
  name: ToolName | (string & {});
  /** String version, e.g. `"1"` — AGENT §3 `version="1"`. Multi-version policy is an open question in `docs/agents.md`. */
  version: string;
  /** One-line human description; goes into the public manifest (API §7 `GET /ai/v1/tools`). */
  description: string;
  /**
   * Argument schema. **`additionalProperties` MUST be `false`** — unlisted arguments are hard
   * errors (AGENT §3). Enforced by `validate_conformance.mjs` rule `tool_spec_closed_input`.
   */
  input_schema: JsonSchema;
  /** Result schema; validated before the value reaches an agent (AGENT §3 "result validation"). */
  output_schema: JsonSchema;
  /** Permission checked against `permission_grants` for the acting subject — AGENT §3/§8. */
  permission: string;
  /** Required context(s) — AGENT §3 `scopes=["tenant"]`. */
  scopes: ToolScope[];
  /** Execution ceiling in ms; default {@link TOOL_TIMEOUT_MS} (AGENT §2 rule 5). */
  timeout_ms: number;
  /** Retry attempts on transient failure — AGENT §3 `retries=1`. */
  retries: number;
  /**
   * Cache TTL in seconds. **Availability tools must be `0`** (AGENT §3 `cache_ttl_s=0  # availability: never cached`,
   * §5, spec §20). LLM results only for idempotent read-only prompts with TTL ≤ 15m (AGENT §9).
   */
  cache_ttl_s: number;
  /** True for mutations; they require an explicit user action + `Idempotency-Key` (AGENT §3/§8, API §1). */
  side_effect: boolean;
  /** Cost bucket for routing/accounting — AGENT §3, §9. */
  cost_class: CostClass;
  /** What runs when this tool fails — AGENT §3 `fallback="deterministic_search"`, §2 rule 2, spec §105. */
  fallback: FallbackKind | (string & {}) | null;
  /** Idempotency requirement for side-effecting tools — API_CONTRACT §1. */
  requires_idempotency_key?: boolean;
  /** Whether the result is untrusted content that must be data-enveloped (AGENT §7/§8). */
  untrusted_output?: boolean;
  /** Network egress flag; only `search_web` may set it (AGENT §3). */
  network_egress?: boolean;
  /** Model/task class hint for the router when `cost_class` is `llm_*` (AGENT §9). */
  task_class?: string | null;
  /** Agents allowed to call this tool in v1 — informational, RBAC is the enforcement point. */
  agents?: AgentName[];
}

/** One executed tool call, as recorded in `agent_runs.tool_calls`. **Source: AGENT_CONTRACT §2 rule 4** (`{tool, args_digest, ok, ms}` plus cost). */
export interface ToolCallRecord {
  /** Tool invoked — AGENT §2 rule 4 `tool`. */
  tool: string;
  /** Tool version. */
  version?: string;
  /** Hash of the arguments; raw args are never logged (privacy, spec §106). AGENT §2 `args_digest`. */
  args_digest: string;
  /** Whether the call succeeded — AGENT §2 `ok`. */
  ok: boolean;
  /** Wall-clock milliseconds — AGENT §2 `ms`. */
  ms: number;
  /** Cost in USD attributed to this call — AGENT §2 "and cost", V1 `agent_runs.cost_usd`. */
  cost_usd?: number;
  /** Cache hit — V1 `llm_calls.cache_hit`. */
  cache_hit?: boolean;
  /** Retry count consumed. */
  attempts?: number;
  /** Error class/message when `ok` is false. */
  error?: string | null;
  /** Number of rows/chunks returned, for eval metrics. */
  result_count?: number | null;
  /** Subject that authorized the call — AGENT §8. */
  subject_type?: string;
  /** @see subject_type */
  subject_id?: Uuid | null;
}

/** A node of the typed execution plan. **Source: AGENT_CONTRACT §2 rule 1** — "The planner emits a typed `Plan` …; each step names a tool from the registry". */
export interface PlanStep {
  /** Step id within the plan, snake_case. */
  id: string;
  /** Registry tool this step runs — AGENT §2 rule 1. */
  tool: ToolName | (string & {});
  /** Step-level arguments (validated against `ToolSpec.input_schema`). */
  args?: JsonObject;
  /** Step ids this step depends on; empty array = runnable immediately (AGENT §2 rule 3). */
  depends_on: string[];
  /** Scheduling mode — AGENT §2 rule 3 parallelism. */
  mode?: PlanStepMode;
  /** Why this step is necessary; the planner must emit *minimum necessary steps* (AGENT §2 loop). */
  rationale?: string | null;
  /** Timeout override for this step; must be ≤ {@link TOOL_TIMEOUT_MS}. */
  timeout_ms?: number;
  /** Whether the step mutates state — AGENT §3 `side_effect`. */
  side_effect?: boolean;
  /** Condition expression evaluated against the accumulated context; null = always run. */
  when?: string | null;
  /** Max cost attribution for the step, USD. */
  max_cost_usd?: number;
}

/**
 * Typed plan produced by `apps/ai/app/orchestrator/planner.py`.
 * **Source: AGENT_CONTRACT §2** (rules 1-3) + §10 loop in `docs/agents.md`; stored in V1
 * `agent_runs.plan jsonb`.
 */
export interface Plan {
  /** Plan version id, e.g. `plan_v1`. */
  version: string;
  /** Intent that produced the plan — API §7.1. */
  intent: string | null;
  /** Ordered steps; a DAG, not a list. */
  steps: PlanStep[];
  /** Declared budget — AGENT §2 rule 2. */
  budget: PlanBudget;
  /** Reason the planner chose this shape; user-visible? No — internal, never streamed (spec §116). */
  rationale?: string | null;
  /** Model used to produce the plan, or `rule` for the deterministic planner — V1 `agent_runs.model`. */
  produced_by?: string;
  /** Estimated total latency in ms, for the §11 NFR budget. */
  estimated_ms?: number | null;
}

/** Planning budget envelope. **Source: AGENT_CONTRACT §2 rule 2** (max 6 tool calls, 3 LLM calls; exceeding must degrade, not hang). */
export interface PlanBudget {
  /** Max tool calls allowed. */
  max_tool_calls: number;
  /** Max LLM calls allowed. */
  max_llm_calls: number;
  /** Per-tool timeout in ms. */
  tool_timeout_ms: number;
  /** Overall request timeout in ms. */
  request_timeout_ms: number;
  /** Max reasoning-model calls (≤1 — AGENT §9). */
  max_reasoning_calls?: number;
  /** Cost ceiling in USD — spec §102/§160. */
  max_cost_usd?: number | null;
}

/** Default budget mirroring AGENT_CONTRACT §2. */
export const DEFAULT_PLAN_BUDGET: PlanBudget = {
  max_tool_calls: MAX_TOOL_CALLS_PER_REQUEST,
  max_llm_calls: MAX_LLM_CALLS_PER_REQUEST,
  tool_timeout_ms: TOOL_TIMEOUT_MS,
  request_timeout_ms: REQUEST_TIMEOUT_MS,
  max_reasoning_calls: MAX_REASONING_CALLS_PER_REQUEST,
  max_cost_usd: null,
};

/** `AgentRunStatus` is imported from `enums.ts` (V1 `agent_runs.status`, line 812). */

/**
 * One recorded agent execution. **Source: AGENT_CONTRACT §2 rule 4/§70 observability**, table
 * V1 `agent_runs` (801-829). `GET /api/v1/admin/ai/runs` reads it (API §9).
 */
export interface AgentRun {
  /** Run id — V1 `agent_runs.id`; returned to the client as `agent_run_id` in the SSE `done` event (API §7). */
  id: Uuid;
  /** Tenant scope — V1 `tenant_id`. */
  tenant_id: Uuid | null;
  /** End user — V1 `user_id`. */
  user_id: Uuid | null;
  /** Merchant on the merchant-agent path — V1 `merchant_id`. */
  merchant_id: Uuid | null;
  /** Conversation the run belongs to — V1 `conversation_id`. */
  conversation_id: Uuid | null;
  /** Client task id for correlation — V1 `task_id`. */
  task_id: string | null;
  /** Acting agent — AGENT §1 roster, V1 `agent`. */
  agent: AgentName | (string & {});
  /**
   * The acting agent's role in the orchestrator loop — AGENT_CONTRACT §1 "Kind" column
   * (`planner|executor|synthesiser|analyst|guard|action|conversational|generator`). Derived from
   * {@link AgentRun.agent} via `AGENT_ROSTER`; not a `agent_runs` column, so optional.
   */
  kind?: AgentKind | null;
  /** Parent run when a sub-agent was spawned — V1 `parent_run_id`, AGENT §8/`docs/agents.md` §8. */
  parent_run_id: Uuid | null;
  /** Model name, null for non-LLM agents — V1 `model`. */
  model: string | null;
  /** Provider id; `mock` must be visible (DECISIONS D4) — V1 `provider`. */
  provider: string | null;
  /** Terminal state — V1 `status`. */
  status: AgentRunStatus;
  /** Typed plan snapshot — V1 `plan jsonb`, AGENT §2. */
  plan: Plan | null;
  /** Truncated input summary (no PII beyond ids) — V1 `input_summary`. */
  input_summary: string | null;
  /** Truncated output summary — V1 `output_summary`. */
  output_summary: string | null;
  /** Per-tool records — V1 `tool_calls jsonb`, AGENT §2 rule 4. */
  tool_calls: ToolCallRecord[];
  /** Retrieval trace (chunk/doc ids + scores) — V1 `retrieval jsonb`, AGENT §7. */
  retrieval: JsonObject[];
  /** Facts cited by the answer — V1 `fact_ids uuid[]`, AGENT §4. */
  fact_ids: Uuid[];
  /** Prompt tokens — V1 `prompt_tokens`. */
  prompt_tokens: number;
  /** Completion tokens — V1 `completion_tokens`. */
  completion_tokens: number;
  /** Cost in USD — V1 `cost_usd numeric(10,6)`; rolled into the admin cost dashboard (API §9, spec §160). */
  cost_usd: number;
  /** Latency — V1 `latency_ms`; NFR API §11. */
  latency_ms: number | null;
  /** Error detail when failed — V1 `error`. */
  error: string | null;
  /** Degradation path taken — V1 `fallback_used`, API §1 failure ladder. */
  fallback_used: FallbackKind | null;
  /** Started instant — V1 `started_at`. */
  started_at: IsoDateTime;
  /** Finished instant; null while running — V1 `finished_at`. */
  finished_at: IsoDateTime | null;
  /** Correlates logs and `audit_logs` — API §1 `X-Request-Id`. */
  request_id?: string | null;
  /** Unmatched numeric/entity claims stripped from generated text — V1 eval metric `hallucination_rate` (AGENT §4/§11). */
  stripped_claims?: number;
}

/** A `permission_grants` row: the only way an agent or human is authorized (AGENT §8, V1 128-139, spec §49). */
export interface PermissionGrant {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Holder kind — V1 `subject_type` (`user|merchant_user|agent|api_key`). */
  subject_type: string;
  /** Holder id — V1 `subject_id` (NOT NULL). */
  subject_id: Uuid;
  /** Merchant scope; null means tenant/platform scope — V1 `merchant_id` comment. */
  merchant_id: Uuid | null;
  /** Granted permission — V1 `permission`, see `PERMISSION_NAME` in `enums.ts`. */
  permission: string;
  /** Who granted it — V1 `granted_by`. A model may never grant itself more (AGENT §8). */
  granted_by: Uuid | null;
  /** Expiry; null = until revoked — V1 `expires_at`, AGENT §8 "grants expire". */
  expires_at: IsoDateTime | null;
  /** Created instant — V1 `created_at`. */
  created_at?: IsoDateTime;
}

/** Result of a registry dispatch; `denied` and `failed` carry the fallback that ran (AGENT §2 rule 2). */
export interface ToolDispatchResult<T = unknown> {
  /** Tool that ran. */
  tool: string;
  /** Whether the call is usable. */
  ok: boolean;
  /** Payload validated against `ToolSpec.output_schema`. */
  result: T | null;
  /** Machine-readable failure code — reuses the API §1 error codes. */
  code?: string | null;
  /** Human-readable failure message; never contains chain-of-thought (spec §116). */
  message?: string | null;
  /** Wall-clock ms — AGENT §2 rule 4. */
  ms: number;
  /** Attempts consumed. */
  attempts?: number;
  /** Fallback that produced the result, when the primary failed — AGENT §2/spec §105. */
  fallback_used?: FallbackKind | null;
  /** Permission denial info — AGENT §8 (audit_logs action `permission_denied`). */
  denied?: { permission: string; subject_type: string; subject_id: Uuid } | null;
}

/** `GET /ai/v1/tools` manifest entry (API_CONTRACT §7). */
export interface ToolManifest {
  /** Every registered tool. */
  tools: ToolSpec[];
  /** Registry version string for client caching. */
  registry_version?: string;
  /** Generated instant. */
  generated_at?: IsoDateTime;
}
