# NEXUS — Agent System (§9, §10, §11)

Status: **to be built.** The invariants for agents/tools/trust are **authoritative in
[`AGENT_CONTRACT.md`](AGENT_CONTRACT.md)**; this doc explains how they are implemented and who owns what, without
forking the roster/tables. Orchestrator mechanics: [AI.md](AI.md) §4; retrieval: [RAG.md](RAG.md); ranking:
[RECOMMENDATION.md](RECOMMENDATION.md); permissions/security: [SECURITY.md](SECURITY.md).

## 1. Two planes, one rule (§9, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1)
Agents run in two processes and are held to the same discipline:
- **AI-service agents** (planners/executors/synthesisers/guards/analysts/generators) — read data only through the tool
  registry; never write commerce-core tables directly (role `nexus_ai`, [DATABASE.md](DATABASE.md) §9).
- **Platform action agents** (`reservation`, `cart`, `checkout`) — run in `services/platform`, may write their domain
  tables, but **only on an explicit user action** ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1).

The authoritative roster (kind, where it runs, what it may write, what it must never do) is
[`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1 — 20 agents covering intent/search/retrieval/location/availability/ranking/
recommendation/review/fact_verification/customer_service/merchant_sales/marketing/seo/analytics/fraud_trust/admin plus
the three action agents. Two guards always sit in the user-facing path: `fact_verification` before a claim renders and
`fraud_trust` before merchant-supplied content influences ranking. **Implement the roster exactly; do not add ad-hoc
agents that bypass the registry.**

## 2. Orchestrator loop (§10) — see [AI.md](AI.md) §4
`receive → classify → plan (min necessary steps) → execute DAG (parallel independents) → collect → verify → rank →
compose EntityCards+citations → log agent_run → return`. Typed `Plan` from `apps/ai/nexus_ai/orchestrator/planner.py`;
budget ≤6 tool / ≤3 LLM calls, 4s/tool, 12s/request; on breach degrade to deterministic search, never hang
([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §2). Dynamic planning is required — a simple query must not fan out to every
tool (§10: "Agent 不应该盲目调用所有工具").

## 3. Tool registry contract (§11, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §3)
Every tool declares a `ToolSpec`: `name, version, description, input_schema (additionalProperties=false),
output_schema, permission, scopes, timeout_ms, retries, cache_ttl_s, side_effect, cost_class (db|vector|llm_cheap|
llm_reason|external), fallback`. Registry = `apps/ai/nexus_ai/tools/registry.py`; public manifest at
`GET /ai/v1/tools` ([`API_CONTRACT.md`](API_CONTRACT.md) §7).

**Dispatch is the only data path** (§52): `agent → registry.dispatch(subject, tool, args)` runs, in order:
```
permission check → argument validation → timeout/retry → execute → result validation → audit/log → return
```
Unknown tool names and unlisted arguments are **hard errors**. Tools are the only way an agent reaches data — no direct
SQL from agent code, no prompt→DB path. Side-effect tools require an explicit user action + `Idempotency-Key`
([`API_CONTRACT.md`](API_CONTRACT.md) §1).

Canonical tool set (implement exactly these, add via registry, never bypass —
[`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §3):
`search_merchants, search_products, search_services, search_reviews, search_location, get_business_hours, get_price,
get_inventory, get_availability, create_reservation, create_cart, update_cart, checkout, get_order_status, search_web,
retrieve_merchant_documents, analyze_reviews, get_user_preferences, set_user_preference, summarize_reviews,
compare_entities, draft_campaign, draft_seo_page, record_event`.

`get_availability.cache_ttl_s = 0` (real-time, §20). `search_web` is the **only** outbound-network tool: allow-listed
hosts, DNS-rebind guarded, 10s cap, response treated as untrusted, results recorded with `source=third_party` + lower
confidence ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §3).

## 4. Permissions — per **subject**, not per model (§48, §49, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §8)
Authorization is checked against `permission_grants` rows for `subject_type IN (user, merchant_user, agent, api_key)`
([DATABASE.md](DATABASE.md) §3.1). The `ai_agent` role grants a **default read-only set**; `refund_payment` and
`publish_campaign` are **never** in a default grant; `create_reservation`/`checkout` require an explicit user action in
the same request. Grants expire (`expires_at`); every denial writes `audit_logs(action='permission_denied')`. Marketing/
SEO/campaign drafts stay in `draft` and publish only on human approval (§27, [MERCHANT.md](MERCHANT.md)).

## 5. Prompt-injection defenses (§50–§52, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §8)
Untrusted inputs: reviews, merchant descriptions, imported docs/URLs, image OCR, user messages, external-agent payloads.
Structural rules (enforced in the AI service):
1. **System prompt is the only instruction source**; untrusted text is data behind a fixed delimiter.
2. Output schemas are validated (schema-constrained decoding where available).
3. **Tool names come only from the registry, never from content** — retrieved/user text cannot name or summon a tool.
4. A model may not raise its own permission scope.
5. Injection attempts inside chunk/doc text are ignored and logged as a `prompt_injection` signal ([RAG.md](RAG.md) §6).
`fraud_trust` guards merchant-supplied content before ranking; `fact_verification` guards claims before render.
Required test coverage: `safety_injection_v1` with **100% containment** as a release gate ([AI.md](AI.md) §6).

## 6. Agent memory (§117, §118)
Four scopes with permission isolation: **session** memory (`conversations.state`), **user-preference** memory
(`user_preferences`, scope `session|long_term`, user view/edit/delete — §32/§33, [CONSUMER.md](CONSUMER.md)), **merchant**
memory (KB scoped to that `merchant_id`), **system** memory. Cross-scope reads are forbidden (an agent may not read
another tenant's/merchant's memory). Long-term "记住我喜欢安静的餐厅" writes a `user_preferences` row with `source=declared`,
retrievable and deletable (§118).

## 7. Model router (§101)
Agents don't pick models directly — they declare a `task_class` and the router chooses the cheapest capable adapter
([AI.md](AI.md) §5, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §9). `reason/plan` (used by `user_intent` planner) is capped
at ≤1 reasoning model call per request.

## 8. Observability (§70)
Each task writes `agent_runs` (agent, model/provider, plan, `tool_calls`, retrieval, `fact_ids`, tokens, `cost_usd`,
`latency_ms`, `status`, `fallback_used`, `parent_run_id`); sub-agents link via `parent_run_id`; joined by `X-Request-Id`.
"Agent 为什么做出这个结果" is answerable by replaying one `agent_run`. Admin surface: `GET /api/v1/admin/ai/runs`
([`API_CONTRACT.md`](API_CONTRACT.md) §9).

## Open questions / risks
- **Roster breadth vs. 6-tool budget:** several agents in §9 (analytics, seo, marketing) will compete for the same
  per-request budget when combined; confirm which are interactive-path vs. async-batch (likely the latter, [AI.md](AI.md)).
- **`subject` identity for external agents:** MCP/UCP calls authenticate `external_principals` rows ([MCP.md](MCP.md));
  the mapping from an external principal to a `permission_grants` subject is not yet fixed — must be defined before phase 4.
- **Guard ordering:** spec mandates fact_verification + fraud_trust in the user path, but their combined latency cost vs.
  the 12s request budget is unmeasured — profile in M3.
- **Tool versioning:** `ToolSpec.version` exists but multi-version coexistence policy (can two versions be live at once?)
  is unspecified.
