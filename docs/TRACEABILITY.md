# NEXUS requirement traceability (§ numbering = `新建 文本文档.txt`)

Every requirement maps to an owning artifact and a verification method. `Status` is updated by the lead
agent as work lands — never by claim, only after the listed verification has been run.

Legend — status: `todo` / `building` / `done` / `deferred(phase-n)`.
Verification kinds: `unit` `integration` `api` `e2e` `visual` `eval` `manual-review`.

## 0. Product definition & positioning

| § | Requirement | Owner artifact | Verify | Status |
|---|---|---|---|---|
| 1-2 | Consumer = natural-language decision layer, not search-list | `apps/ai/app/orchestrator`, `apps/web/(consumer)/search` | e2e vertical slice | building |
| 3 | Merchant = AI business agent, not a webpage | `services/platform/merchant`, `apps/ai/app/agents/merchant_sales` | e2e merchant flow | todo |
| 4 | Not a Yelp/Amazon/Shopify/OpenTable clone; AI Decision Layer | `docs/VISION.md`, `docs/PRODUCT.md` | manual-review | building |
| 5-7 | HK first, global-ready, dense-vertical cold start | `tenants` table, `infra/config/markets.yaml`, i18n routing | integration | building |
| 8 | Homepage: premium (Apple+Perplexity), NL input, rails | `apps/web/app/(consumer)/page.tsx`, `packages/ui` | visual | building |
| 9 | AI search accepts natural language | API_CONTRACT §7 `/ai/v1/search/stream` | e2e | building |

## 1. Understanding, agents, tools, retrieval

| § | Requirement | Owner artifact | Verify | Status |
|---|---|---|---|---|
| 10 | Query understanding → Intent (uncertain fields allowed) | `apps/ai/app/nlu/intent.py`, `AGENT_CONTRACT` §7.1 | eval `intent_v1` | building |
| 11-14 | Multi-agent roster + orchestrator (dynamic plan, not blind tool calls) | `apps/ai/app/orchestrator/{planner,executor}.py`, `agents/*` | unit + eval `tool_selection_v1` | building |
| 15-17 | Tool registry: schema/validation/timeout/retry/logging/auth/errors | `apps/ai/app/tools/registry.py` | unit + `GET /ai/v1/tools` | building |
| 18-20 | RAG pipeline (parse→chunk→embed→hybrid→rerank→pack→LLM) | `apps/ai/app/rag/*` | eval `rag_faithfulness_v1` | building |
| 21 | Hybrid search = keyword + vector + metadata + geo + ranking | `apps/ai/app/search/sql.py` | integration + eval `search_relevance_v1` | building |
| 22-23 | Postgres + pgvector as phase-1 stores (no premature infra) | `infra/db/migrations/V1__init.sql`, compose | integration | done (schema applied) |
| 24 | Recommendation = candidate→filter→rank→LLM reasoning | `apps/ai/app/recommend/*` | eval | building |
| 25 | Every recommendation explainable, bullets trace to facts | `MatchExplanation.fact_id`, `packages/ui/MatchExplanations` | visual + unit | building |
| 26-27 | Trust layer (source/timestamp/confidence) + freshness TTL | `facts` table, `AGENT_CONTRACT` §4-5 | unit + api | building |

## 2. Merchant side

| § | Requirement | Owner artifact | Verify | Status |
|---|---|---|---|---|
| 28-30 | Onboarding funnel, verification, publish | `services/platform/merchant` (status machine) | api + e2e | building |
| 31-32 | AI merchant import (URL/PDF/menu → offerings + KB) | `merchant/imports`, `MerchantImportPort`, `apps/ai/app/rag` | api (mock+real) | building |
| 33 | Merchant dashboard (overview→billing) | `apps/web/app/(merchant)/*` | visual | todo |
| 34 | Merchant AI sales agent grounded in own KB | `apps/ai/app/merchant_agent` | eval + api | building |
| 35-36 | AI customer service + human handoff on low confidence | `handoffs` table, `merchant_agent/confidence` | e2e | building |
| 37 | AI marketing agent: drafts only, publish needs explicit approval | `campaigns.status`, `approve-publish` endpoint | unit (RBAC) + api | building |
| 38-39 | SEO agent + programmatic SEO with uniqueness/quality guard | `seo_pages.quality_score`, `agents/seo` | eval + manual-review | todo |
| 40 | Merchant API `/api/v1/merchant` with strict scopes | `api_keys`, `permission_grants`, `packages/sdk` | api + unit | building |
| 41 | Merchant data ownership/export | `GET /api/v1/merchant/export` | api | todo |

## 3. Consumer side

| § | Requirement | Owner artifact | Verify | Status |
|---|---|---|---|---|
| 42-44 | Account, preference memory, personalization with view/edit/delete/reset | `user_preferences`, `/me/preferences`, `account` UI | api + e2e | building |
| 45 | Multi-turn conversation state (太贵了/近一点/不吃辣) | `apps/ai/app/nlu/state_merger.py` | unit + e2e | building |
| 46-47 | Cards + AI result interface (summary+cards+compare+map+actions) | `EntityCard`, `packages/ui`, `/search` | visual | building |
| 48 | Comparison table from real data only | `/ai/v1/compare`, `CompareTable` | api + visual | todo |
| 49 | Map experience (markers, clustering, directions) | `/m/[slug]` map panel (SVG, no key faking) | visual | building |
| 50 | Local discovery ("我附近有什么好玩的") | `agents/location` + intent geo resolution | eval | todo |
| 51-53 | Reservation service (industry-agnostic), universal cart, checkout | `resource_pools/availability_slots/reservations`, `carts/orders/payments` | integration (concurrency) | building |
| 54 | Payment via mature provider, PCI-aware, idempotent, webhooked | `PaymentProvider` + `DemoPaymentProvider` | api | building |

## 4. Platform: tenancy, security, growth, observability

| § | Requirement | Owner artifact | Verify | Status |
|---|---|---|---|---|
| 55-57 | Multi-tenant + RBAC incl. AI-agent permissions | `tenants/merchant_users/permission_grants`, ArchUnit + interceptor | unit (tenant isolation) | building |
| 58 | Security: auth, rate limit, validation, SQLi/XSS/CSRF/SSRF, secrets, audit | `platform/filters`, `audit_logs`, CSP headers | api + security tests | building |
| 59-60 | Prompt-injection defense + tool-call authorization chain | `AGENT_CONTRACT` §8, `rag/envelope.py` | eval `safety_injection_v1` | building |
| 61-63 | Trust & fraud, review system, review intelligence with evidence | `trust_signals`, `reviews`, `review_summaries` | unit + api | building |
| 64-66 | Merchant analytics, AI analytics agent, event tracking schema | `v_merchant_funnel`, `agents/analytics`, `events` | integration | building |
| 67-71 | Growth engine, viral loop, merchant/consumer referral, creators | `referrals`, `collections`, `growth` module | api + e2e | todo |
| 72 | AI-generated local guides from real data | `seo_pages(kind='guide')`, `collections` | manual-review | todo |
| 73-75 | Monetization tiers, marketplace revenue, ranking integrity | `subscriptions`, `coupons`, sponsored separation | unit (ranking) | building |
| 76 | Admin console | `apps/web/app/(admin)`, `/api/v1/admin/**` | e2e | todo |
| 77-78 | Observability incl. AI traces, tokens, cost | `agent_runs`, `llm_calls`, admin cost dashboard | api + visual | building |
| 79-80 | Evaluation system + agent benchmark metrics | `eval_suites/eval_cases/eval_runs`, `apps/ai/app/eval` | eval gate | building |
| 81 | Testing pyramid (unit→perf) | `tests/`, module test suites | all | building |
| 82-84 | Browser E2E (Playwright), visual regression, agent-driven browser checks | `tests/e2e` | e2e + visual | todo |
| 85-87 | Responsive, design system, visual direction | `packages/ui`, mobile-first breakpoints | visual | building |
| 88-89 | Frontend/backend/AI stack | D1 in `docs/DECISIONS.md` | build | done |
| 90-91 | Architecture + repository shape | D2/D3, `docs/ARCHITECTURE.md` | manual-review | done |
| 92 | Documentation set | `docs/*.md` | manual-review | building |
| 93-95 | Seed data (500/5000/10000, marked synthetic), demo accounts, demo flows | `data/seed`, `/auth/demo` | integration + quality.sql | building |
| 96 | Growth landing page + acquisition funnels | `/`, `/for-business`, SEO routes | visual | todo |
| 97 | Network effect / data flywheel / feedback learning | `feedback_events`, ranking weights, EMA updates | eval trend | todo |
| 98-99 | External AI distribution (MCP/UCP), agent-to-agent commerce | `adapters/{mcp,ucp}.py`, `agent_profiles` | api + contract tests | todo |
| 100 | Privacy: export/delete/reset; merchant data ownership | `/me/export`, `deletion_requests` | api | todo |
| 101 | i18n (en/zh-HK/zh-CN), currency, timezone, HK specifics | `apps/web/messages`, `tenants.config` | e2e | building |
| 102 | Reliability: retries, breaker, timeouts, fallback, queue, idempotency | `platform/retry`, `idempotency_keys`, orchestrator budgets | unit + api | building |
| 103 | AI failure ladder: fallback model → deterministic → human | `AGENT_CONTRACT` §2.5, `/ai/v1/search` always-on | integration | building |
| 104 | Caching policy; never cache live price/inventory/availability | Redis TTL map, `facts.expires_at` | unit | building |
| 105 | No fake reviews/traffic/merchants; demo labelled demo | `data_origin`, `flags.demo`, seed disclaimers | manual-review + api header | building |
| 106 | AI transparency: show why, show uncertainty | `MatchExplanations`, degraded badge | visual | building |
| 107 | Legal/compliance per jurisdiction configurable | `tenants.config` | manual-review | todo |
| 108 | One-command dev env + README runnable + .env.example | `Makefile`, compose, `README.md` | manual run | building |
| 109 | CI/CD pipeline (lint→type→unit→integration→build→e2e→scan) | `.github/workflows/ci.yml` | CI run | todo |
| 110 | Git discipline + branch strategy | `docs/DEPLOYMENT.md`, commit history | manual-review | building |

## Verification protocol (spec §156-157)

Nothing is `done` until the row's verification has actually been executed and its output recorded in
`docs/STATUS.md`. Each milestone close-out must answer, in writing:

```
What works / What doesn't / What is fake / What is placeholder /
What is technically fragile / What is slow / What is expensive /
What breaks at 10x / What breaks at 100x / What must be refactored
```

## Explicitly deferred (spec §169)

Global payments, multi-country rollout, 20M merchants, microservice decomposition, Kubernetes, large-scale ML
training. These stay out of phase 1 even though the schema keeps seams (`tenants`, `agent_profiles`,
`SearchBackend`, `PaymentProvider`).
