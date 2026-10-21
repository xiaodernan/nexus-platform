# NEXUS — AI Service (`apps/ai`)

Status: **to be built.** Owner: FastAPI service, port 8000 (`apps/ai/nexus_ai/**`), DB role `nexus_ai`
([`API_CONTRACT.md`](API_CONTRACT.md) §0). This doc covers query understanding, conversation-state merge, the
orchestrator loop, the model router, cost accounting and the eval gate. Agent roster/tool registry live in
[AGENTS.md](AGENTS.md); retrieval internals in [RAG.md](RAG.md); ranking math in [RECOMMENDATION.md](RECOMMENDATION.md).
Canonical shapes: [`API_CONTRACT.md`](API_CONTRACT.md) §7, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §2/§9/§11.

## 1. Directory / file ownership (target layout)
```
apps/ai/nexus_ai/
  nlu/            understand.py (Intent), state_merger.py (multi-turn merge, §34)
  orchestrator/   planner.py (typed Plan), executor.py (DAG), verify.py
  search/         sql.py (hybrid SQL seam), backend.py (SearchBackend iface, §16)
  rag/            ingest.py chunk.py embed.py retrieve.py rerank.py pack.py
  recommend/      score.py rank.py explain.py
  tools/          registry.py dispatch.py   (see AGENTS.md §3)
  models/         router.py adapters/{mock,anthropic,openai}.py
  compare/        compare.py (§37)
  eval/           suites.py runners.py gates.py (§11)
  observability/  run_logger.py cost.py (§70)
```

## 2. Query understanding → `Intent` (§8)

One LLM (or mock) call, **schema-constrained** (`task_class=intent_extract`, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §9).
The canonical object is [`API_CONTRACT.md`](API_CONTRACT.md) §7.1 — do not fork it; key contract points:
- Fields: `intent, category, location, time, budget{}, party_size, preferences[], constraints[], sort_preference,
  urgency, language, confidence{}, unknowns[]`.
- **Uncertainty is first-class (§8):** unstated fields stay `null`; per-field confidence in `confidence{}`; anything
  genuinely needed but absent is listed in `unknowns[]` (e.g. `party_size`) and asked **once** in a follow-up. The
  `user_intent` agent is forbidden from inventing location/budget/party_size ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1).
- `intent ∈ {discover_merchant, discover_offering, reserve, purchase, ask_merchant, compare, plan_experience, unknown}`.
- `location` may be a `district` token resolved to `{lat,lng,radius_m}`; `time` may be `explicit` or relative resolved
  against request `context.now`; `budget.per ∈ {party, person}`.
- Acceptance: given `"帮我找沙田适合情侣约会的餐厅，预算500，安静一点，周六晚上"` → `category=restaurant`,
  `location=Sha Tin`, `budget.max=500 HKD`, `preferences=[{ambience,quiet,+1}]`, `time` resolves to next Saturday
  evening, `party_size=null`, `unknowns=["party_size"]`. Golden case in `intent_v1` suite (§6).

## 3. Conversation state & merge rules (§34)

State persists on `conversations.state` (jsonb) and is merged per turn by `apps/ai/nexus_ai/nlu/state_merger.py`.
Deterministic merge rules (illustrative, from [`API_CONTRACT.md`](API_CONTRACT.md) §7.1) — merges edit the *previous*
Intent, they do not re-derive from scratch:

| Follow-up (zh-HK) | Merge |
|---|---|
| `太贵了` | `budget.max *= 0.7` (keep currency); add implicit feedback `too_expensive` (§99) |
| `便宜一点` / `平啲` | lower `budget.max`; set `sort_preference=price_low` |
| `近一点` | `sort_preference=distance`; tighten `location.radius_m` |
| `不吃辣` | append `constraints += {cuisine_avoid, spicy}` |
| `换成周日` | rewrite `time`; keep other slots |
| `把前三家比较一下` | `intent=compare`; carry last 3 subject ids from `recommendation_sets` |

Rules:
1. **Additive unless contradicted:** a new turn never silently drops a prior satisfied slot unless the user contradicts it.
2. **Contradiction wins** with the latest turn (e.g. new district replaces old).
3. **Confidence recompute:** a slot the user explicitly states = confidence 1.0; inherited slots decay slightly per turn
   (they may be stale intentions).
4. **Never re-guess unknowns:** if `unknowns` still non-empty after merge, surface one clarifying question, don't fabricate (§8).
5. Merge is pure/testable → unit-tested independently of any LLM (mock provider makes it deterministic, D4).
- Acceptance: the 4-turn script (§34: 找餐厅 → 太贵了 → 近一点 → 不吃辣) yields a final Intent with reduced budget,
  distance sort, tightened radius, and the spicy-avoid constraint.

## 4. Orchestrator: plan → execute → verify (§10, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §2)

```
receive → classify intent → build Plan (min necessary steps) → execute DAG (parallel where independent)
→ collect → verify facts → rank → compose response (EntityCards + citations) → log agent_run → return
```
- **Dynamic planning (§10):** the planner (`orchestrator/planner.py`) emits a typed `Plan`; a greeting or "what's open
  now" must NOT trigger retrieval+rerank+summary. Each step names a registry tool.
- **Budgets (hard, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §2):** ≤6 tool calls, ≤3 LLM calls, 4s/tool, 12s/request.
  Exceeding → degrade to deterministic search, never hang.
- **Parallelism:** independent steps (availability ∥ reviews ∥ geo) run concurrently; dependents don't.
- **Verify:** `fact_verification` guard runs before any user-facing claim is rendered; `fraud_trust` runs before
  merchant-supplied content influences ranking ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1). LLM output is
  post-validated: numeric/entity claims matched back to retrieved facts, unmatched stripped (hallucination counter, §6).
- **Streaming (§116):** statuses are user-legible (`understanding → searching → results → summary → done`), never
  chain-of-thought. `event: error` → client falls back to `POST /ai/v1/search` (deterministic).

## 5. Model router & cost accounting (§101, §102, §160, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §9)

`apps/ai/nexus_ai/models/router.py` maps task_class → cheapest model that can do the job:
`intent_extract`/`classify` → cheap-fast (schema-constrained); `embed` → embedding model (batched, cached by content
hash); `rerank` → cross-encoder (top-40 only); `summary` → mid; `reason/plan` → reasoning model (≤1/request);
`generate_ui_copy` → mid. Adapters share one interface: `MockAdapter` (default, `NEXUS_LLM_PROVIDER=mock`, D4) /
`AnthropicAdapter` / `OpenAIAdapter`. Never bind to a single model (§101); never route a simple question to the most
expensive model (§102).

**Accounting (§70, §160):** every call → `llm_calls` (provider, model, purpose, tokens, `cost_usd`, latency, `cache_hit`);
every request → `agent_runs` (agent, plan, `tool_calls`, `fact_ids`, tokens, `cost_usd`, `fallback_used`). Aggregated in
the admin cost dashboard and exposed as `cost_per_search`, `cost_per_conversation`, `cost_per_recommendation` (§160).
**No feature may claim a live model in docs unless `NEXUS_LLM_PROVIDER != mock`** (D4) — mock output is labelled
`"provider":"mock"` in responses and UI badge.

Caching (§103): embeddings by content hash; LLM results only for idempotent read-only prompts, TTL ≤15m; **never** for
price/inventory/availability.

## 6. Evaluation gate (§71–§73, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §11)

`suites`: `intent_v1` (1000 cases), `search_relevance_v1`, `rag_faithfulness_v1`, `tool_selection_v1`,
`safety_injection_v1`, `personalization_v1`. Stored in `eval_suites`/`eval_cases` (expected = intent fields,
must_include/must_exclude/behaviour). Per-run metrics in `eval_runs.metrics`: task success, tool success, precision@10,
relevance nDCG, **hallucination rate**, p50/p95 latency, cost, human-intervention rate.

**Release gate (blocks the merge — "an agent may not ship and hope", §11):**
- hallucination rate **< 2%**
- injection-suite containment **= 100%**
- p95 `/ai/v1/search` **< 250ms** warm (first stream event <1.2s, full answer <6s, [`API_CONTRACT.md`](API_CONTRACT.md) §11)
- **no regression > 3pp** on task success

`apps/ai/nexus_ai/eval/gates.py` is the CI enforcement point; wired by [TESTING.md](TESTING.md) and [ROADMAP.md](ROADMAP.md) M3+.

## Open questions / risks
- **Merge-rule drift vs. mock provider:** deterministic merges are testable, but real-provider `太贵了 → budget*0.7` is a
  heuristic; validate the multiplier feels right with real usage data before relying on it (§34).
- **`plan_experience` (§151) needs itinerary/cross-merchant planning** that exceeds the 6-tool/3-LLM budget; may require
  a separate async planner path not covered here — likely phase-2+.
- **Router cost model assumes known per-token prices**; with `mock` there is no real cost signal, so cost dashboards are
  zero-valued until a real provider is configured — don't mistake "cheap" for "working".
- **nDCG ground truth** for `search_relevance_v1` needs labelled relevance; sourcing honest labels (not synthetic-as-truth)
  is an open task (§71, §86).
