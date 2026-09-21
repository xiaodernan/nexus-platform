# NEXUS Agent / Tool / Trust Contract — AUTHORITATIVE

Companion to `docs/API_CONTRACT.md`. This file fixes the invariants every agent, tool and ranking
implementation must honour. Deviating silently is the fastest way to make NEXUS untrustworthy.

## 1. Agent roster (§9) and ownership

| Agent | Kind | Runs in | May write | Must not |
|---|---|---|---|---|
| `user_intent` | planner | AI svc | — | invent location/budget/party_size |
| `search` | executor | AI svc | — | return unpublished/suspended merchants |
| `retrieval` | executor | AI svc | — | mix tenants |
| `location` | executor | AI svc | — | precise geo without user consent |
| `availability` | executor | AI svc | — | cache beyond 60s |
| `ranking` | executor | AI svc | `recommendation_sets` | let paid rank influence organic score (§67) |
| `recommendation` | synthesiser | AI svc | `recommendation_sets` | emit bullet without `fact_id` |
| `review` | analyst | AI svc | `review_summaries` | invent quotes |
| `fact_verification` | guard | AI svc | — | be skipped on user-facing claims |
| `reservation` / `cart` / `checkout` | action | platform svc | domain tables | execute without explicit user action |
| `customer_service` | conversational | AI svc | via platform door (§7.0) | answer below confidence floor → handoff |
| `merchant_sales` | conversational | AI svc | via platform door (§7.0), `leads` | act outside merchant grants |
| `marketing` | generator | AI svc | `campaigns(draft)`, `coupons(draft)` | publish (§27) |
| `seo` | generator | AI svc | `seo_pages(draft)` | publish pages below quality bar (§28-30) |
| `analytics` | analyst | AI svc | — | expose other merchants' data |
| `fraud_trust` | guard | AI svc | `trust_signals`, `moderation_cases` | auto-delete without audit |
| `admin_agent` | analyst | AI svc | — | any write |

Two agents always sit in the user-facing path: `fact_verification` before a claim is rendered, and
`fraud_trust` before merchant-supplied content influences ranking.

## 2. Orchestrator loop (§10)

```
receive → classify intent → build plan (min necessary steps) → execute DAG (parallel where independent)
→ collect → verify facts → rank → compose response (EntityCards + citations) → log agent_run → return
```
Rules:
1. **Dynamic planning.** A greeting or "what's open now" must not trigger retrieval+rerank+summary. The planner emits a
   typed `Plan` (`apps/ai/app/orchestrator/planner.py`); each step names a tool from the registry.
2. Budget: max 6 tool calls and 3 LLM calls per user-facing request; exceeding it must degrade to deterministic search,
   not hang.
3. Parallelism: independent steps (availability + reviews + geo) run concurrently; dependent ones do not.
4. Every step records `agent_runs.tool_calls` with `{tool, args_digest, ok, ms}` and cost.
5. Cancellation/timeouts propagate: 4s per tool, 12s per request.

## 3. Tool registry (§11) — every tool declares this

```python
ToolSpec(
  name="get_availability",
  version="1",
  description="Real-time reservable slots for a merchant in a window.",
  input_schema={...},              # JSON Schema, additionalProperties=false
  output_schema={...},
  permission="read_availability",  # checked against permission_grants for the acting subject
  scopes=["tenant"],               # required context
  timeout_ms=4000, retries=1, cache_ttl_s=0,   # availability: never cached (§20)
  side_effect=False,               # mutation tools require explicit user action + Idempotency-Key
  cost_class="db",                 # db|vector|llm_cheap|llm_reason|external
  fallback="deterministic_search", # what runs when this fails (§105)
)
```
Registry: `apps/ai/app/tools/registry.py`. Tools are the **only** way an agent reaches data — no direct SQL from agent code,
no raw prompt→DB path (§52). Calls flow `agent → registry.dispatch(subject, tool, args)` which performs, in order:
permission check → argument validation → timeout/retry → execute → result validation → audit/log → return.
Unknown tool names and unlisted arguments are hard errors.

Canonical tool names (implement exactly these; add to registry, never bypass):
`search_merchants, search_products, search_services, search_reviews, search_location, get_business_hours, get_price,
get_inventory, get_availability, create_reservation, create_cart, update_cart, checkout, get_order_status, search_web,
retrieve_merchant_documents, analyze_reviews, get_user_preferences, set_user_preference, summarize_reviews,
compare_entities, draft_campaign, draft_seo_page, record_event`.

`search_web` is the only outbound-network tool: allow-listed hosts, DNS-rebind guarded, 10s cap, response treated as
untrusted (§51), and results recorded with `source=third_party` + lower confidence than merchant data.

## 4. Trust layer (§19) — non-negotiable

- Any value shown to a user (price, hours, rating, distance, availability) must resolve to a `facts` row or be
  visibly marked as an estimate.
- Renderer contract: `EntityCard.facts[]` + `ai_match.reasons[].fact_id`. If `fact_id` is missing, the UI must not
  render that bullet.
- `source` hierarchy for conflict resolution: `merchant` (fresh) > `observed` > `imported` > `third_party` > `inferred`.
  Conflicts create a `trust_signals` row rather than silently picking.
- `confidence < 0.6` ⇒ phrase as uncertain in copy; `< 0.4` ⇒ omit and offer handoff. Never upgrade confidence for
  presentation.
- LLM output is post-validated: every numeric/entity claim in generated text is matched back to retrieved facts;
  unmatched claims are stripped and counted in `hallucination_rate` (§72). This is the single most important
  quality gate in the product.

## 5. Freshness policy (§20)

| Attribute | TTL on read | Recompute trigger |
|---|---|---|
| opening hours | 24h | merchant edit, weekly crawl |
| description / KB docs | 7d | reindex job |
| price | 6h | merchant edit, import |
| inventory | 15m | import/order decrement |
| availability | 0 (real-time) | every request |
| review summary | 24h or ≥5 new reviews | batch job |
| popularity/trending | 1h | analytics job |

`stale=true` must be surfaced as "价格可能已更新" in the cart and never used to silently charge.

## 6. Hybrid search + ranking (§13, §17, §67, §113)

```
candidates = keyword(tsvector ∪ trgm) ∪ vector(pgvector cosine) ∪ geo(bbox radius) ∪ metadata filters
score = w_relevance*rel + w_quality*quality + w_distance*dist + w_price*price_fit
      + w_availability*avail + w_personalization*pers + w_popularity*pop + w_freshness*fresh
```
- Weights are data (`infra/config/ranking_weights.yaml`), versioned in `recommendation_sets.strategy` (`hybrid_v1`).
- Quality = Bayesian-smoothed rating (shrunk to tenant mean by `n/(n+15)`), so a 5.0 with 2 reviews does not beat a
  4.6 with 200.
- Relevance floor: candidates below the floor are dropped before scoring — never ranked by popularity to hide irrelevance.
- **Sponsored separation (§66-67):** organic score is computed and stored first; promoted slots are inserted
  afterwards with `flags.sponsored=true` and a visible label, capped at 1 in the top 5, and can never displace the
  organic best match. Organic score is never a function of plan or spend.
- Explanations are generated from the top contributing features (§18): "✓ 距离你 700m · ✓ 符合预算 · ✓ 评分 4.7(200+ 条) ·
  ✓ 周六 19:00 有位" — each with `fact_id`.
- Feedback (§99-100) updates personalization weights slowly (EMA, min 3 signals) and is never treated as ground truth alone:
  explicit feedback + implicit (click/dwell) + transaction outcome are combined.

## 7. RAG pipeline (§12)

```
parse → clean → semantic chunk (240-400 tokens, 12% overlap, section-aware) → embed(model, dim 1024)
→ store(chunks.embedding, search_tsv) → hybrid retrieve (tsvector ∪ vector, filter tenant+merchant)
→ rerank (cross-encoder or LLM listwise on top 40) → context pack (dedupe, cite document_id) → LLM
```
- Retrieval always filtered by `tenant_id` (+ `merchant_id` in the merchant-agent path) before similarity ranking.
- Context pack keeps `document_id`, `chunk_id`, `source_uri` so every answer can cite.
- Chunk text is **untrusted content** (§51): wrapped in a data envelope, instruction-like text inside it is ignored and
  logged as a `prompt_injection` signal.
- Index staleness: editing a merchant doc enqueues reindex of that doc's chunks only.
- No answer without retrieval: if top score < threshold, the agent says it does not know and offers handoff.

## 8. Prompt-injection & permissions (§50-52)

- Untrusted: reviews, merchant descriptions, imported docs/URLs, images' OCR, user messages, external-agent payloads.
- Structural rules: system prompt is the only instruction source; untrusted text is data with a fixed delimiter;
  output schemas are validated (schema-constrained decoding where available); tool names can only come from the registry
  (never from content); a model may not raise its own permission scope.
- Tool authorization is per **subject**, not per model: `permission_grants` rows for `subject_type IN (user, merchant_user,
  agent, api_key)`. `ai_agent` role grants a default read-only set; `refund_payment` and `publish_campaign` are never in a
  default grant, and `create_reservation`/`checkout` require an explicit user action in the same request.
- Grants expire (`expires_at`) and every denial writes `audit_logs(action='permission_denied')`.

## 9. Model router & cost (§101-102, §160)

`apps/ai/app/models/router.py` maps task class → model, cheapest that can do the job:

| task_class | default provider | notes |
|---|---|---|
| `intent_extract` | cheap/fast | schema-constrained |
| `classify/route` | cheap/fast | |
| `embed` | embedding model | batched, cached by content hash |
| `rerank` | reranker (cross-encoder) | top-40 only |
| `summary` | mid | reviews/KB |
| `reason/plan` | reasoning model | ≤1 per request |
| `generate_ui_copy` | mid | |

Provider adapters implement one interface (`AnthropicAdapter`, `OpenAIAdapter`, `MockAdapter`); `NEXUS_LLM_PROVIDER=mock`
runs the whole product offline with deterministic, clearly-labelled heuristic output. Cost/latency/tokens per call go to
`llm_calls`; per request to `agent_runs`; aggregated in the admin cost dashboard and exposed via `cost_per_search`,
`cost_per_conversation`, `cost_per_recommendation`.
Caching: embeddings by content hash; LLM results only for idempotent read-only prompts with TTL ≤ 15m; **never** for
price/inventory/availability.

## 10. Event schema (§58) — single shape, one place

```jsonc
{ "name": "search", "occurred_at": "…", "tenant_id": "…",
  "actor_type": "user|merchant_user|agent|system|anonymous", "actor_id": "uuid|null",
  "subject_type": "merchant|offering|search_result|conversation|null", "subject_id": "uuid|null",
  "session_id": "…", "conversation_id": "uuid|null",
  "properties": {}, "context": { "locale":"zh-HK","device":"mobile","geo_precision":"district" } }
```
Required names: `search, view, click, favorite, compare, reserve, cart_add, checkout, purchase, cancel, review, share,
feedback, ai_answer, handoff, campaign_publish, agent_run`. `event_id` (uuid) is the dedupe key — producers must retry
safely.

North-star derivation (§162): a `search` followed within 30 min by `reserve | purchase | favorite | share`
(with `degraded=false`) counts as one fulfilled intent, written to `v_north_star`. Page views are not the target metric.

## 11. Evaluation gate (§71-73)

`suites`: `intent_v1` (1000 cases), `search_relevance_v1`, `rag_faithfulness_v1`, `tool_selection_v1`,
`safety_injection_v1`, `personalization_v1`. Metrics per run: task success, tool success, precision@10, relevance nDCG,
**hallucination rate**, p50/p95 latency, cost, human-intervention rate.
Release gate: hallucination rate < 2%, injection-suite containment = 100%, p95 search < 250ms,
and no regression > 3pp on task success. Failing the gate blocks the merge — an agent may not "ship and hope".

## 12. i18n / HK specifics (§111-112)

`en`, `zh-HK` (default), `zh-CN`. Currency default HKD; timezone `Asia/Hong_Kong`; addresses use
district/area + MTR proximity; Traditional Chinese is the primary copy language and all AI output echoes the user's
locale. Seed data is clearly labelled demo/synthetic everywhere (§109, §155).
