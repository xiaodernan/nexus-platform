# NEXUS — Architecture (Phase 1)

Status: **to be built.** Binding: [`DECISIONS.md`](DECISIONS.md) D1–D8. This document explains the shape the code must
take and *why*. HTTP/data invariants live in the contracts, not here.

## 1. Phase-1 style: modular monolith, not microservices

§84 sketches `apps/*` + `services/*` as separate deployables but explicitly permits a **modular monolith** while the
team is small and forbids premature microservices (§84, §169). [`DECISIONS.md`](DECISIONS.md) **D2** locks the real
topology: **three processes, not nine.**

| Process | Path | Stack (D1) | Port |
|---|---|---|---|
| Web (BFF + SSR/SSG) | `apps/web` | Next 15 / React 19 / TS 5 / Tailwind / Framer Motion | 3000 |
| AI service | `apps/ai` | Python 3.11 / FastAPI / Pydantic v2 / asyncpg / httpx | 8000 |
| Platform service | `services/platform` | Spring Boot 3.5 / Java 25 / Flyway / Spring Security / JPA | 8080 |
| Data | `infra/db` | PostgreSQL 16 + pgvector (`pgvector/pgvector:pg16`) | 5432 |
| Cache/streams | `infra` | Redis 7 (`redis:7.4-alpine`) | 6379 |

The §81/§82 split (Java commerce core + Python AI service) is kept; the nine `services/*` (user/merchant/search/
recommendation/commerce/reservation/payment/notification/analytics) exist as **Java packages** inside `services/platform`,
mirroring the future service boundaries so extraction stays mechanical (D2). One Next app with `(consumer)`/`(merchant)`/
`(admin)` route groups, not three apps (D2 — avoids duplicating the design system and tripling CI).

## 2. §83 diagram — rendered honestly for phase 1

The spec's §83 diagram implies independent services behind a gateway. What actually gets built first is a monolith with
in-process module boundaries plus one AI service; the "API Gateway" is the Next BFF, and "User/Merchant/Search/Commerce
Core" are packages, not network hops.

```
                         Browser
                            │
                    ┌───────▼────────┐
                    │  apps/web      │   Next.js 3000  (SSR/SSG + BFF proxy /api/*)
                    │  (consumer|    │   ← reads nexus_session cookie in RSC (§D5)
                    │   merchant|    │
                    │   admin)       │
                    └───┬────────┬───┘
          /api/v1/**    │        │   /api/v1/ai/** (proxied), /ai/v1/** direct for streams
                        ▼        ▼
        ┌───────────────────┐  ┌──────────────────────┐
        │ services/platform │  │ apps/ai              │   FastAPI 8000
        │ (Spring Boot 8080)│◄─┤  nlu/ search/ rag/   │   AI⇄platform via scoped HTTP token
        │  auth merchants   │  │  orchestrator tools/ │   (no shared write path, §52)
        │  offerings carts   │  │  models/ recommend/  │
        │  orders reserve    │  │  compare/ eval/ obs/ │
        │  payments reviews  │  └─────────┬────────────┘
        │  conversations     │            │ nexus_ai role (SELECT + narrow RW)
        │  events growth     │            │
        │  admin  ← nexus_app│            │
        └─────────┬──────────┘            │
                  │  nexus_app RW         │
                  ▼                       ▼
        ┌──────────────────────────────────────────┐
        │ PostgreSQL 16 + pgvector (5432)          │  tsvector + pg_trgm + HNSW + bbox/haversine
        │ Redis 7 (6379): cache, streams, sessions │
        └──────────────────────────────────────────┘
                  │                         │
        PaymentProvider(demo)         LLM adapter (mock|anthropic|openai, D4)
        (extension seam, §42)         (extension seam, §101)
```

Deferred-but-reserved (drawn in later phases, not wired in phase 1): `UcpAdapter` behind
`GET /.well-known/ucp`, the Nexus MCP server behind `/mcp`, OpenSearch/Elasticsearch behind `SearchBackend`, Kafka
behind Redis Streams (§122), ClickHouse/BigQuery behind Postgres analytics (§121).

## 3. Process boundaries & data access (§52, [`API_CONTRACT.md`](API_CONTRACT.md) §0)

There is **no `LLM → database` path.** Enforcement is by *role*, not by convention:
- `nexus_app` (platform): read-write on commerce tables; **the only writer of cart/order/reservation/payment/merchant**.
- `nexus_ai` (AI service): **SELECT** on merchants/offerings/locations/reviews/facts/business_hours/availability_slots;
  read-write **only** on `documents, chunks, facts, recommendation_sets, feedback_events, agent_runs, llm_calls, eval_*,
  review_summaries, seo_pages, campaigns`. Anything it must mutate in the commerce core (cart, reservation, order) goes
  through platform HTTP APIs with a scoped token.
- Web never talks to Postgres; it calls platform + AI via the BFF.

See [DATABASE.md](DATABASE.md) §9 for the grant split. The roles are created by `infra/postgres/init/00_roles.sql`
(first-boot initdb, re-applied by `scripts/db_apply_migrations.sh`), not by `V1__init.sql` — and Flyway runs under a
third credential, the infra superuser, because the runtime role cannot `ALTER` a table it does not own (§9, D30).

## 4. Request lifecycles

### 4.1 Consumer AI search (streamed) — §7, §10, §116
```
browser → apps/web input → POST /ai/v1/search/stream (SSE)  [API_CONTRACT §7]
  web BFF forwards to apps/ai orchestrator with user token + context{geo,now,locale,party_size}
  orchestrator:
    classify intent (nlu, Intent JSON)          → event: status {understanding} + event: intent
    plan (min necessary steps, AGENT §2)         → event: status {searching}
    execute DAG: search_merchants ∥ availability ∥ reviews (tools/registry.dispatch)
    hybrid retrieve+rank (search/sql.py, recommend) → event: results {EntityCard[], set_id}
    fact_verification guard on every claim (AGENT §1) → event: summary {citations:[fact_id]}
    log agent_runs (cost/tokens/latency)          → event: done {agent_run_id, latency_ms, cost_usd, degraded}
  apps/ai calls platform HTTP to persist recommendation_sets/conversation state where needed
  on LLM failure → failure ladder (§5) → event: error → client retries deterministic POST /ai/v1/search
```
Budget guard: ≤6 tool calls, ≤3 LLM calls, 4s/tool, 12s/request ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §2); on breach
degrade to deterministic search, never hang.

### 4.2 Merchant onboarding (§21, §22)
```
apps/web/(merchant) signup (POST /api/v1/auth/register | oauth) → creates users + owner merchant_users
  → POST /api/v1/merchant/businesses (merchant row, status=draft, tenant set)
  → verification → POST /api/v1/merchant/imports {url|files} → 202 {job_id}  [platform enqueues]
      apps/ai import pipeline: crawl→parse→clean→chunk→embed→classify→proposed offerings + documents/chunks
      (data_origin='demo'/'imported'; facts created with source; nothing published)
  → merchant reviews proposals (GET /imports/{job_id}) → edits offerings
  → POST /api/v1/merchant/businesses/{id}/publish (publish_listing permission) → search_tsv triggers fire, rows indexable
```
Acceptance: publish is the only point the merchant becomes discoverable ([MERCHANT.md](MERCHANT.md)).

### 4.3 Checkout (§41, §42)
```
POST /api/v1/carts/price-check → per-item stale flags (facts.expires_at vs now)   [never silently charge stale]
POST /api/v1/carts/checkout  (Idempotency-Key required)
  platform: re-price each item against fresh facts; if stale → 409 conflict
  create order (status=created) + payment row (provider=demo, idempotency_key unique)
  return {order, payment_intent}
  demo confirm: POST /api/v1/payments/{order}/confirm → payment captured → order=paid → merchant notification
  real provider: webhook POST /api/v1/webhooks/payments/{provider} (signature verified, idempotent)
```

## 5. Failure ladder (§105, [`API_CONTRACT.md`](API_CONTRACT.md) §1, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md))
```
LLM error/timeout → fallback model (router) → deterministic search endpoint (/ai/v1/search, pure SQL) → human handoff
```
The site must never be unusable because the LLM is down. `/ai/v1/search` (deterministic hybrid SQL) must always work;
`ai_unavailable` (503) must never break it. Every degrade is recorded in `agent_runs.fallback_used`
(`model_fallback|deterministic_search|human`) and surfaced as `degraded:true` in `event: done`.

## 6. Caching layers — and what must never be cached

| Layer | Where | TTL policy |
|---|---|---|
| HTTP/CDN (public merchant reads) | `apps/web` + ETag/`Cache-Control` | list/read endpoints cacheable ([`API_CONTRACT.md`](API_CONTRACT.md) §11) |
| App cache (search results, merchant data, LLM read-only results) | Redis | embeddings by content hash; LLM results only idempotent read-only, TTL ≤15m ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §9) |
| Vector cache | Redis keyed by query-text hash | — |
| DB-internal freshness | `facts.expires_at`, `offerings.price_updated_at`, `availability_slots.updated_at` | per-attribute TTL ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §5) |

**Never cached (§103, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §5/§9):** real-time **price, inventory, availability**
(no-store, `cache_ttl_s=0`). Availability may not be cached beyond 60s ([`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §1).
Using an expired cache to deceive the user is prohibited (§103); `stale=true` renders `价格可能已更新`.

## 7. Extension seams (keep UCP/MCP/model logic out of business code, §43)

- **`SearchBackend`** interface (§16): phase-1 impl is Postgres-only SQL in `apps/ai/app/search/sql.py` +
  `services/platform/.../search/` (D3). OpenSearch/Elasticsearch is a second impl; call sites never change. Image
  `elasticsearch:8.13.4` is pre-cached for when it is enabled.
- **`PaymentProvider`** interface (§42): `demo` impl ships phase 1; real providers (Stripe/AlipayHK/PayMe/HSBC) are
  adapters; card data is never stored (D5).
- **LLM adapters** (`AnthropicAdapter`/`OpenAIAdapter`/`MockAdapter`, one interface): `NEXUS_LLM_PROVIDER=mock` runs the
  whole product offline with deterministic labelled output (D4, [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §9).
- **UCP / MCP**: `UcpAdapter` builds `/.well-known/ucp` profiles from `agent_profiles`; MCP server exposes the fixed tool
  set ([`API_CONTRACT.md`](API_CONTRACT.md) §10). Phase 4 wires them ([UCP.md](UCP.md), [MCP.md](MCP.md)).

## 8. Tenancy, i18n, observability, reliability

- **Tenancy (§47, D5):** every tenant-owned table carries `tenant_id`; repositories take `TenantContext` as first
  argument and add the predicate — a query without a tenant filter fails review. Cross-tenant reads return 404 (not 403).
- **i18n (§111, §112):** `en`/`zh-HK` (default)/`zh-CN`; HKD; `Asia/Hong_Kong`; district/MTR addressing. See
  [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §12.
- **Observability (§69, §70, §160):** structured logs + traces; every agent task → `agent_runs` (+ `llm_calls`), joined
  by `X-Request-Id`; token/cost/latency per call and per request; admin cost dashboard + `cost_per_search`/
  `cost_per_conversation`/`cost_per_recommendation`. (No dedicated observability doc in this set — distributed here, in
  [AI.md](AI.md) and [TESTING.md](TESTING.md).)
- **Reliability (§104):** retries, circuit breaker, timeouts, fallback, queue, idempotency; target 99.9%.

## 9. What will break at 10x / 100x (§157 self-review — required)

Honest, phase-1-aware scaling notes. These are **design debt we accept now**, not bugs.

### At 10x (≈ tens of thousands of users, ~5K merchants)
- **Modular monolith (8080)** becomes the CPU/connection bottleneck for commerce writes → read-replicas + separate the
  write-heavy order/payment path; packages already mirror services so extraction is mechanical (D2).
- **Postgres HNSW on a single `chunks` table** with one shared box: index build time and memory grow with embedding
  count; vector recall may drop under concurrent writes → plan partitioning by `tenant_id`/`merchant_id`.
- **`events` bigserial table** on the primary: high write amplification + VACUUM pressure → move analytics off OLTP
  primary (§121 ClickHouse later; §122 Redis Streams→Kafka).
- **LLM cost/latency** on synchronous per-request orchestration: no queue yet for non-interactive work (imports, review
  summaries, SEO gen) → those belong on an async worker now, not on the request path.
- **Redis as the only cache** becomes a single point of eviction thrash for hot search results → namespace/evict policy.
- **Full-text `tsvector('simple')`** with Chinese handled by simple tokeniser → poor Chinese recall; needs a real CJK
  analyser (e.g. `zhparser`/`pg_jieba`, not in the pgvector image) or a search-engine `SearchBackend` swap.

### At 100x (≈ millions of users, ~100K+ merchants, multi-city)
- **App-code tenant isolation** (no DB-enforced RLS): one missing predicate in one new query is a data-leak at scale →
  adopt Postgres row-level security as defence-in-depth (see [DATABASE.md](DATABASE.md) §10 risk).
- **bbox + haversine geo scan** over all `locations` in a bbox: fine for one district, degrades in dense multi-city
  geographies and at large radii → introduce PostGIS/`geography` or a geo-sharded index; the current image lacks PostGIS
  ([DATABASE.md](DATABASE.md) §7).
- **Single-tenant pgvector + OpenSearch not yet separated**: hybrid relevance & rerank cross-encoder on top-40 becomes
  the latency ceiling → dedicated vector DB (Qdrant/Weaviate/Milvus, §15) and dedicated search cluster (§16).
- **Stateless JWT HS256 (dev)** and single signing key don't survive multi-region/rotation → RS256 with JWKS (§D5).
- **Analytics in Postgres views (`v_merchant_funnel`, `v_north_star`)** computing over raw `events`: full scans at 100x →
  pre-aggregated rollups / warehouse (§121).
- **LLM spend**: eval-gated but not budget-gated per tenant/merchant → hard quota + caching tiers + smaller models
  ([AGENT_CONTRACT.md](AGENT_CONTRACT.md) §9).
- **`facts` table** as the single provenance source read on every render: becomes read-hot → materialise per-subject
  fact snapshots / cache the fresh-ones only.

## 10. Definition of done (D7) for architectural work
1. Compiles & runs here (commands in README); 2. unit+integration+**contract** tests pass for HTTP shapes; 3. UI verified
in a real browser, screenshot under `tests/evidence/`; 4. no stub pretending to work — unimplemented raises
`NotImplementedError`/501. Full list: [`DECISIONS.md`](DECISIONS.md) D7, [TESTING.md](TESTING.md).

## Open questions / risks
- ~~**DB roles not provisioned**~~ — closed: `infra/postgres/init/00_roles.sql` creates `nexus_app`/`nexus_ai` and
  grants the §0 split table by table, and it is re-applied by `scripts/db_apply_migrations.sh`.
- ~~**App role keeps a leftover `CREATE` on the schema**~~ — closed (D32): the grant was made when `nexus_app` also
  ran Flyway, which D30 ended. It buys nothing (schema `CREATE` cannot alter a table the role does not own) and the
  file that grants it is re-run by `db_apply_migrations.sh`, not only at initdb, so revoking it there reaches the
  existing dev database too. Measured after the revoke: `nexus_app` gets `permission denied for schema public` on
  `CREATE TABLE`, while every DML grant it needs stays — `ALTER DEFAULT PRIVILEGES` in the same file keeps handing
  it the tables a later migration creates.
- **RLS absent:** tenancy is enforced purely in application code; acceptable at phase-1 scale, a real risk at 100x.
- **CJK full-text quality** with `tsvector('simple')` may be insufficient for the primary zh-HK market before the
  search-engine seam is enabled — validate in M2.
- **Sync vs async AI boundaries:** imports/summaries/SEO must be confirmed as background workers, not inline, before M3
  to protect the p95/first-event budgets (§11).
