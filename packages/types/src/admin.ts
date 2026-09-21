/**
 * Admin console types.
 *
 * Contract: API_CONTRACT §9 (verbatim route list: `/admin/{users|merchants|orders|reservations|
 * reviews|reports}`, `/admin/moderation` + `/{case_id}/resolve`, `/admin/ai/runs`,
 * `/admin/ai/costs?group_by=agent|model|day`, `/admin/search/analytics`,
 * `/admin/merchants/{id}/suspend`, `/admin/system/health`, `/admin/ai/ask`), plus the hard rule
 * "All admin routes require `role IN (platform_admin, platform_ops)` and write `audit_logs`".
 * Tables: V1 `moderation_cases` (571-584), `trust_signals` (558-569), `audit_logs` (881-899),
 * `agent_runs` (801-829), `llm_calls` (831-846), `eval_suites/cases/runs` (848-878),
 * `rate_limit_buckets` (901-905), `idempotency_keys` (907-915).
 * Spec: §68 Admin Console, §69/§70 Observability, §71 Evaluation System, §72 Agent Benchmark,
 * §126 Admin AI, §127 Automated Moderation, §160 AI Cost, §161 Business Metrics.
 */

import type {
  AuditAction,
  EvalSuiteName,
  ErrorCode,
  ModerationAutoAction,
  ModerationStatus,
  ModerationSubjectType,
  Severity,
  TrustSignalKind,
  TrustSignalStatus,
} from "./enums.js";
import type { AgentRun } from "./tools.js";
import type { IsoDateTime, JsonObject, Money, Nullable, Timestamps, Uuid } from "./common.js";

/* enum unions used below are declared in enums.ts */

/** Console areas listed in spec §68 (Users, Merchants, Orders, Reservations, Reviews, Reports, AI, Search, Content, Fraud, Billing, System). */
export const ADMIN_AREA = [
  "users",
  "merchants",
  "orders",
  "reservations",
  "reviews",
  "reports",
  "ai",
  "search",
  "content",
  "fraud",
  "billing",
  "system",
] as const;
/** Admin console section — spec §68, API_CONTRACT §9. */
export type AdminArea = (typeof ADMIN_AREA)[number];

/** Admin list filter shared by `GET /api/v1/admin/{users|merchants|orders|…}` (API §9). */
export interface AdminListQuery {
  /** Free-text search over name/id/slug. */
  q?: string;
  /** Tenant filter — cross-tenant reads need `platform_admin` (DECISIONS D5). */
  tenant_id?: Uuid | null;
  /** Status filter using the domain's own enum values. */
  status?: string | null;
  /** Range filters for reports. */
  from?: IsoDateTime | null;
  /** @see from */
  to?: IsoDateTime | null;
  /** Page size / cursor — API §1. */
  limit?: number;
  /** @see limit */
  cursor?: string | null;
  /** Sort key, snake_case. */
  sort?: string | null;
}

/** A row in `GET /api/v1/admin/users`. */
export interface AdminUserRow {
  /** V1 `users.id`. */
  id: Uuid;
  /** V1 `users.email` (citext). */
  email: string | null;
  /** V1 `users.display_name`. */
  display_name: string | null;
  /** V1 `users.role`. */
  role: string;
  /** V1 `users.status`. */
  status: string;
  /** V1 `users.tenant_id`. */
  tenant_id: Uuid | null;
  /** V1 `users.locale`. */
  locale: string;
  /** V1 `users.created_at`. */
  created_at: IsoDateTime;
  /** V1 `users.last_login_at`. */
  last_login_at: IsoDateTime | null;
  /** V1 `users.deleted_at` — soft delete pending (spec §106). */
  deleted_at: IsoDateTime | null;
  /** Counters derived from V1 `events` / `orders`. */
  stats?: { orders: number; reservations: number; reviews: number };
}

/** A row in `GET /api/v1/admin/merchants`. */
export interface AdminMerchantRow {
  /** V1 `merchants.id`. */
  id: Uuid;
  /** V1 `merchants.slug`. */
  slug: string;
  /** V1 `merchants.display_name`. */
  display_name: string;
  /** V1 `merchants.legal_name`. */
  legal_name: string;
  /** V1 `merchants.status` — `suspend` moves it to `suspended` (API §9). */
  status: string;
  /** V1 `merchants.data_origin` — demo rows must stay labelled (DECISIONS D6). */
  data_origin: string;
  /** V1 `merchants.ownership_verified`. */
  ownership_verified: boolean;
  /** V1 `merchants.plan` — must not affect organic rank (spec §67). */
  plan: string;
  /** V1 `merchants.tenant_id`. */
  tenant_id: Uuid;
  /** V1 `merchants.rating_agg` / `review_count`. */
  rating: Nullable<number>;
  /** @see rating */
  review_count: number;
  /** Open trust signals — V1 `trust_signals`. */
  trust_flags?: number;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
}

/** `POST /api/v1/admin/merchants/{id}/suspend` body (API_CONTRACT §9; writes `audit_logs`). */
export interface SuspendMerchantRequest {
  /** Reason recorded in the audit log — V1 `audit_logs.action` = `suspend_merchant`. */
  reason: string;
  /** Suspension length in days; null = indefinite. */
  duration_days?: Nullable<number>;
  /** Notify the merchant via `notifications` (spec §124). */
  notify?: boolean;
}

/** A moderation case. **Source: API_CONTRACT §9** (`GET /admin/moderation`,
 * `POST /admin/moderation/{case_id}/resolve {action,note}`), V1 `moderation_cases` (571-584);
 * spec §127 automated moderation, §53 fraud/trust.
 */
export interface ModerationCase extends Timestamps {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid | null;
  /** `review|merchant|document|message|listing|seo_page` — V1 `subject_type`. */
  subject_type: ModerationSubjectType;
  /** Subject row — V1 `subject_id` (NOT NULL). */
  subject_id: Uuid;
  /** Why it was raised — V1 `reason`. */
  reason: string;
  /** Policy reference — V1 `policy`. */
  policy: string | null;
  /** What an automated pass already did (`none|hide|flag|reject`) — V1 `auto_action`;
   * auto-delete without audit is forbidden (AGENT §1 `fraud_trust`). */
  auto_action: ModerationAutoAction | null;
  /** Queue state — V1 `status` default `open`. */
  status: ModerationStatus;
  /** Assigned reviewer — V1 `assigned_to`. */
  assigned_to: Uuid | null;
  /** Resolution detail written by `POST …/resolve` — V1 `resolution jsonb`. */
  resolution: JsonObject;
  /** Raised at — V1 `created_at`. */
  created_at: IsoDateTime;
  /** Resolved at — V1 `resolved_at`. */
  resolved_at: IsoDateTime | null;
  /** Snapshot of the offending content for the reviewer. */
  subject_preview?: Nullable<JsonObject>;
}

/** `POST /api/v1/admin/moderation/{case_id}/resolve` body (API_CONTRACT §9: `{action,note}`). */
export interface ModerationResolveRequest {
  /** Reviewer action. */
  action: "approve" | "reject" | "hide" | "flag" | "dismiss" | "escalate";
  /** Note stored in `resolution` and the audit log. */
  note?: string | null;
  /** Optional reviewer-assigned severity. */
  severity?: Nullable<Severity>;
}

/** A trust signal. **Source: V1 `trust_signals` (558-568)**; written only by `fraud_trust`
 * (AGENT §1) and when a source conflict appears rather than silently picking (AGENT §4); spec §53.
 */
export interface TrustSignal {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Merchant — V1 `merchant_id`. */
  merchant_id: Uuid;
  /** Signal class — V1 `kind`, see `TRUST_SIGNAL_KIND` in `enums.ts`. */
  kind: TrustSignalKind | (string & {});
  /** `info|warn|high|critical` — V1 `severity`. */
  severity: Severity;
  /** Model/rule score 0..1 — V1 `score`. */
  score: Nullable<number>;
  /** Evidence rows/fact ids — V1 `evidence jsonb`. */
  evidence: JsonObject;
  /** `rule|model|human` — V1 `detected_by`. */
  detected_by: string;
  /** `open|reviewing|dismissed|confirmed` — V1 `status`. */
  status: TrustSignalStatus;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
}

/** An audit log entry. **Source: V1 `audit_logs` (881-896)**; every permission denial is written
 * here (AGENT §8) and admin routes always write it (API §9); spec §50.
 */
export interface AuditLogEntry {
  /** bigserial row id, stringified — V1 `id`. */
  id: string;
  /** Tenant — V1 `tenant_id`. */
  tenant_id: Uuid | null;
  /** `user|merchant_user|agent|api_key|system` — V1 `actor_type`. */
  actor_type: string;
  /** Actor id — V1 `actor_id`. */
  actor_id: Uuid | null;
  /** Action name — V1 `action`, see `AUDIT_ACTION` in `enums.ts`. */
  action: AuditAction | (string & {});
  /** Subject kind — V1 `subject_type`. */
  subject_type: string | null;
  /** Subject id — V1 `subject_id`. */
  subject_id: Uuid | null;
  /** Merchant context — V1 `merchant_id`. */
  merchant_id: Uuid | null;
  /** Client IP — V1 `ip inet`. */
  ip: string | null;
  /** User agent — V1 `user_agent`. */
  user_agent: string | null;
  /** State before the mutation — V1 `before jsonb`. */
  before: Nullable<JsonObject>;
  /** State after the mutation — V1 `after jsonb`. */
  after: Nullable<JsonObject>;
  /** Extra context — V1 `metadata jsonb`. */
  metadata: JsonObject;
  /** When — V1 `created_at`. */
  created_at: IsoDateTime;
  /** Correlation id shared with `agent_runs` — API §1 `X-Request-Id`. */
  request_id?: string | null;
}

/** `GET /api/v1/admin/ai/costs?group_by=agent|model|day` row (API_CONTRACT §9; spec §102/§160). */
export interface CostRollupRow {
  /** Group key — an agent name, model id, or ISO date depending on `group_by`. */
  group_key: string;
  /** Group-by dimension echoed back. */
  group_by: "agent" | "model" | "day";
  /** Number of runs/LLM calls in the bucket. */
  calls: number;
  /** Prompt tokens — V1 `agent_runs.prompt_tokens`. */
  prompt_tokens: number;
  /** Completion tokens — V1 `agent_runs.completion_tokens`. */
  completion_tokens: number;
  /** Spend in USD — V1 `cost_usd numeric(10,6)`. */
  cost_usd: number;
  /** Per-unit costs named by AGENT §9: `cost_per_search`, `cost_per_conversation`, `cost_per_recommendation`. */
  cost_per_search?: Nullable<number>;
  /** @see cost_per_search */
  cost_per_conversation?: Nullable<number>;
  /** @see cost_per_search */
  cost_per_recommendation?: Nullable<number>;
  /** p50/p95 latency in ms — AGENT §11 metrics. */
  p50_latency_ms?: Nullable<number>;
  /** @see p50_latency_ms */
  p95_latency_ms?: Nullable<number>;
  /** Cache hit ratio 0..1 — V1 `llm_calls.cache_hit`, AGENT §9 caching rules. */
  cache_hit_rate?: Nullable<number>;
}

/** Aggregated unit costs exposed per AGENT_CONTRACT §9 ("exposed via cost_per_search, …"). */
export interface UnitCosts {
  /** USD per search. */
  cost_per_search: number;
  /** USD per conversation. */
  cost_per_conversation: number;
  /** USD per recommendation set. */
  cost_per_recommendation: number;
  /** Currency of the derived totals on the merchant side — V1 `subscriptions.currency`. */
  display_amount?: Nullable<Money>;
}

/** `GET /api/v1/admin/search/analytics` row (API §9, spec §56/§161). */
export interface SearchAnalyticsRow {
  /** Bucket instant (day) — derived from V1 `events.occurred_at`. */
  day: IsoDateTime;
  /** Tenant. */
  tenant_id: Uuid | null;
  /** Search events counted — V1 `v_north_star.searches`. */
  searches: number;
  /** Zero-result searches; an empty state, not an error (DECISIONS D6). */
  zero_result_searches: number;
  /** Fulfilled intents — V1 `v_north_star.fulfilled_intents`, spec §162. */
  fulfilled_intents: number;
  /** Distinct sessions — V1 `v_north_star.sessions`. */
  sessions: number;
  /** Degraded (fallback) share 0..1 — API §7 `degraded`. */
  degraded_rate: Nullable<number>;
  /** Top queries as `(query, count)` pairs, snake_case keys. */
  top_queries?: Array<{ query: string; count: number }>;
  /** Conversion rate to reserve/purchase, 0..1. */
  conversion_rate?: Nullable<number>;
}

/** `GET /api/v1/admin/system/health` response (API_CONTRACT §9, spec §104). */
export interface SystemHealth {
  /** Overall verdict. */
  status: "ok" | "degraded" | "down";
  /** Time of the probe. */
  checked_at: IsoDateTime;
  /** Per-dependency detail. */
  checks: Array<{
    /** Dependency name (`postgres|redis|llm|search|payment|queue`). */
    name: string;
    /** Verdict. */
    status: "ok" | "degraded" | "down";
    /** Round-trip latency. */
    latency_ms?: Nullable<number>;
    /** Detail message. */
    message?: string | null;
    /** Which error code the caller would see if this dependency is used (API §1). */
    error_code?: Nullable<ErrorCode>;
    /** Whether the AI path can still serve deterministic search (API §1 failure ladder). */
    deterministic_fallback_available?: boolean;
  }>;
  /** Service versions/build refs. */
  versions?: Record<string, string>;
  /** Rate-limit bucket pressure — V1 `rate_limit_buckets`. */
  rate_limited_ratio?: Nullable<number>;
}

/** `POST /api/v1/admin/ai/ask` request (API_CONTRACT §9 "Admin Analytics Agent, read-only tools"; spec §57/§126). */
export interface AdminAskRequest {
  /** Natural-language question — API §9 `{question}`. */
  question: string;
  /** Restrict the answer to one tenant — DECISIONS D5. */
  tenant_id?: Uuid | null;
  /** Date range the question covers. */
  range?: { from: IsoDateTime; to: IsoDateTime } | null;
  /** Optional prior conversation for follow-ups — API §7. */
  conversation_id?: Uuid | null;
}

/** `POST /api/v1/admin/ai/ask` response. */
export interface AdminAskResult {
  /** Answer text; read-only tools only, no writes (API §9, AGENT §1 `admin_agent` "must not: any write"). */
  answer: string;
  /** Agent run that produced it — V1 `agent_runs.id`. */
  agent_run_id: Uuid;
  /** Tools used, all read-only — AGENT §2 rule 4. */
  tool_calls: string[];
  /** Facts/rows the numbers came from — AGENT §4 (an unbacked claim is stripped, spec §72). */
  fact_ids: Uuid[];
  /** Machine-readable table for the chart renderer. */
  table?: { columns: string[]; rows: Array<Record<string, unknown>> } | null;
  /** Whether the answer degraded to a deterministic SQL read — API §1. */
  degraded: boolean;
  /** Latency of the whole ask. */
  latency_ms: number;
  /** Provider; `mock` is visible in the badge (DECISIONS D4). */
  provider?: string | null;
}

/** An eval suite header. **Source: V1 `eval_suites` (848-855)**; names per AGENT_CONTRACT §11. */
export interface EvalSuite {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Suite name, unique — V1 `name` (`intent_v1`, `search_relevance_v1`, …); AGENT §11. */
  name: EvalSuiteName | (string & {});
  /** Description — V1 `description`. */
  description: string | null;
  /** Case count — V1 `size`; `intent_v1` targets 1000 cases (AGENT §11). */
  size: number;
  /** Version — V1 `version` default `1`. */
  version: string;
  /** Created — V1 `created_at`. */
  created_at: IsoDateTime;
}

/** One eval case. **Source: V1 `eval_cases` (857-866)**, AGENT §11. */
export interface EvalCase {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Owning suite — V1 `suite_id`. */
  suite_id: Uuid;
  /** Query text — V1 `query`. */
  query: string;
  /** Locale — V1 `locale` default `zh-HK`. */
  locale: string;
  /** Injected context (prefs, geo, time) — V1 `context jsonb`. */
  context: JsonObject;
  /** Expected intent fields, `must_include`, `must_exclude`, behaviour — V1 `expected jsonb`. */
  expected: JsonObject;
  /** Tags for slicing results — V1 `tags text[]`. */
  tags: string[];
}

/**
 * Metrics recorded for an eval run. **Source: AGENT_CONTRACT §11** ("Metrics per run: task success,
 * tool success, precision@10, relevance nDCG, hallucination rate, p50/p95 latency, cost,
 * human-intervention rate"), V1 `eval_runs.metrics jsonb` (line 874).
 */
export interface EvalMetrics {
  /** Task success rate 0..1 — V1 key `task_success`. */
  task_success: Nullable<number>;
  /** Tool-call success rate 0..1 — V1 key `tool_success`. */
  tool_success: Nullable<number>;
  /** precision@10 — AGENT §11. */
  precision_at_10: Nullable<number>;
  /** Relevance nDCG — AGENT §11. */
  ndcg: Nullable<number>;
  /**
   * Hallucination rate 0..1 — AGENT §4/§11. **Release gate: < 2%**; unmatched numeric/entity
   * claims are stripped and counted here (spec §72).
   */
  hallucination_rate: Nullable<number>;
  /** p50 latency ms. */
  p50_latency_ms: Nullable<number>;
  /** p95 latency ms — gate: search p95 < 250ms (AGENT §11, API §11). */
  p95_latency_ms: Nullable<number>;
  /** Total cost USD for the run. */
  cost_usd: Nullable<number>;
  /** Human-intervention (handoff) rate 0..1. */
  human_intervention_rate: Nullable<number>;
  /** Injection-suite containment 0..1 — gate: 100% (AGENT §11). */
  injection_containment: Nullable<number>;
}

/** Release-gate thresholds from AGENT_CONTRACT §11 — used by CI to block merges. */
export const RELEASE_GATES = {
  /** hallucination rate < 2%. */
  max_hallucination_rate: 0.02,
  /** injection-suite containment = 100%. */
  min_injection_containment: 1,
  /** p95 search < 250ms (API §11). */
  max_p95_search_ms: 250,
  /** no regression > 3 percentage points on task success. */
  max_task_success_regression_pp: 3,
} as const;

/** An eval run. **Source: V1 `eval_runs` (868-878)**, AGENT §11. */
export interface EvalRun {
  /** Row id — V1 `id`. */
  id: Uuid;
  /** Suite run — V1 `suite_id`. */
  suite_id: Uuid;
  /** Agent under test — V1 `agent`, AGENT §1 roster. */
  agent: string;
  /** Model under test — V1 `model`. */
  model: string | null;
  /** Strategy under test — V1 `strategy`, AGENT §6. */
  strategy: string | null;
  /** Aggregate metrics — V1 `metrics jsonb`. */
  metrics: EvalMetrics;
  /** Per-case outcomes — V1 `case_results jsonb`. */
  case_results: Array<{ case_id: Uuid; passed: boolean; detail?: JsonObject }>;
  /** Started — V1 `started_at`. */
  started_at: IsoDateTime;
  /** Finished — V1 `finished_at`. */
  finished_at: IsoDateTime | null;
  /** Gate verdict — AGENT §11 ("Failing the gate blocks the merge"). */
  passed_gate?: boolean;
  /** Which gate(s) failed. */
  gate_failures?: string[];
}

/** Report row for `GET /api/v1/admin/reports` (API §9, spec §68/§161). */
export interface AdminReportRow {
  /** Report identifier. */
  report: string;
  /** Bucket instant. */
  bucket: IsoDateTime;
  /** Metric name. */
  metric: string;
  /** Value; null when genuinely absent. */
  value: Nullable<number>;
  /** Money-valued metrics. */
  amount?: Nullable<Money>;
  /** Tenant scope. */
  tenant_id?: Uuid | null;
}

/** Agent-run list item for `GET /api/v1/admin/ai/runs` (API §9). */
export interface AdminAgentRunRow extends AgentRun {
  /** Derived: number of tool calls in the run. */
  tool_call_count?: number;
  /** Derived: whether the run degraded — V1 `status`/`fallback_used`. */
  degraded?: boolean;
}
