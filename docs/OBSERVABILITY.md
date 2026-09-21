# NEXUS Observability (§69, §70, §160, §161)

Status: **to be built** — the tables, headers and endpoints this document describes are defined by
`infra/db/migrations/V1__init.sql` (`agent_runs`, `llm_calls`, `events`, `audit_logs`) and
[`API_CONTRACT.md`](API_CONTRACT.md) §9. No dashboard exists yet.

## 1. Four signals, one correlation key

| Signal | Where it is written | Read surface |
|---|---|---|
| logs | structured JSON lines, every service, fields `ts level service tenant_id request_id actor_id msg` | stdout → container log driver |
| metrics | request latency histograms, DB pool, cache hit ratio, queue depth | `GET /actuator/health`, `/actuator/metrics` (platform), `/ai/healthz` + `/ai/v1/observability/summary` |
| traces | `X-Request-Id` generated at the edge and forwarded to platform → AI → tools; every span writes `agent_runs` | `GET /api/v1/admin/ai/runs` |
| AI behaviour | `agent_runs` (plan, tool_calls, retrieval, fact_ids, tokens, cost, fallback_used) + `llm_calls` per model call | admin AI views |

`X-Request-Id` is the join key across all four. A log line without it is a defect.

## 2. The question observability must answer

Spec §70: *"Agent 为什么做出这个结果?"* Replayable from one row:

```
GET /api/v1/admin/ai/runs?conversation_id=...        → the run tree (parent_run_id)
GET /api/v1/admin/ai/runs/{id}                       → plan, selected tools, args digests, per-step ok/ms,
                                                       retrieval hits with scores, fact_ids used, provider+model,
                                                       prompt/completion tokens, cost_usd, latency_ms, status,
                                                       fallback_used, and the final composed response
```

If `status='fallback'` the row must say which rung of the §105 ladder was used
(`model_fallback | deterministic_search | human`), and the response carried `X-Nexus-Degraded` plus the UI
"降級模式" badge. A degraded answer that looks like a normal answer is an observability failure even when the
request returned 200.

## 3. Cost accounting (§160)

`llm_calls` is the ledger: provider, model, purpose, tokens, `cost_usd`, latency, `cache_hit`. Unit prices live in
`infra/config/model_pricing.yaml` (per 1M tokens, by model) so cost math is data, not code. Derived dashboards:

```
cost_per_search          = sum(llm_calls.cost_usd where purpose in (intent, rerank, summary)) / count(search events)
cost_per_recommendation  = ... / count(recommendation_sets)
cost_per_conversation    = ... / count(conversations)
cost_per_merchant        = ... grouped by agent_runs.merchant_id
cost_per_transaction     = ... grouped by order id from tool_calls
```
Router enforcement (§102): a `task_class` has a max cost ceiling; exceeding it logs a `cost_budget_exceeded`
event rather than silently calling the expensive model.

## 4. Business metrics (§161-162)

Consumed from `events` only — never from a second tracking system, so a number cannot disagree with itself.

- Consumer: DAU/WAU/MAU, retention cohorts, searches per user, actions per search, search→action conversion.
- Merchant: active merchants, retention, AI conversations, qualified leads, reservations, orders, GMV.
- AI: task success, hallucination rate (from `fact_verification` rejections), p50/p95 latency, cost,
  human-intervention rate.
- **North star**: Successful Consumer Intent Fulfillment ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §10) —
  a `search` followed within 30 minutes by `reserve | purchase | favorite | share` with `degraded=false`.
  Materialized in `v_north_star`. Page views are explicitly not a target metric.

## 5. Alerts worth paging on

| Condition | Why P1 |
|---|---|
| hallucination rate > 2% over 1h | the product's core promise (§19) is breaking |
| `/ai/v1/search` (deterministic) error rate > 1% | the §105 last-resort path is down; only handoff remains |
| fallback rate > 20% over 15m | users are silently getting degraded answers at scale |
| checkout idempotency conflicts spiking | double-charge risk |
| cross-tenant probe hits (`permission_denied` from a service token) | isolation bug, security review |
| `prompt_injection` signals > baseline 5x | someone is probing the KB path |
| cost per search up 3x day-over-day | router regression |

## 6. Non-goals

No distributed tracing backend, no metrics warehouse, no ClickHouse in phase 1 (§121, §158): Postgres tables plus
admin endpoints are enough to run and reason about the product at this scale, and every one of these tables is the
shape an OpenTelemetry/warehouse exporter would fill later.

## Open questions / risks
- Log/metric retention and PII minimisation in `events.properties` is unspecified; needed before real users (§106).
- `agent_runs.tool_calls` stores args digests, not payloads — replay fidelity for debugging vs. privacy is unresolved.
- No trace propagation exists between web BFF and services yet; `X-Request-Id` must be forwarded by the BFF, which is
  a code review item rather than a design one.
