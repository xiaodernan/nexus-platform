# NEXUS — Roadmap (execution backbone)

Status: **planning; nothing is implemented.** Milestones **M0–M7** come from [`DECISIONS.md`](DECISIONS.md) D8 (which
collapses the spec's 13 §167 milestones into 7 because "anything not on the vertical-slice path is deferred"). §n →
`新建 文本文档.txt`. Each task: **(owner module · depends-on · done-when/acceptance · priority P0–P5 per §137)**.
P0 system broken · P1 core journey broken · P2 important feature · P3 UX · P4 optimization · P5 nice-to-have.

## 0. The MVP acceptance path (§168 → §170)
**The vertical slice IS the MVP gate.** Nothing below is "done" until this runs end to end and is recorded by the two
Playwright journeys in [TESTING.md](TESTING.md) §2:
```
Consumer "帮我找一个适合情侣约会的地方" → NEXUS understands → Search → RAG → Ranking → Recommendation
→ Merchant page → AI explanation → Action → Merchant receives the need → Merchant AI Agent answers
→ Lead / Reservation / Cart → Analytics → both sides get value      (§170 = MVP COMPLETE)
```
Owner: cross-cutting. Depends-on: M1–M5. Done-when: `tests/e2e/vertical_slice.spec.ts` passes green (real browser,
screenshot in `tests/evidence/`, `degraded` path also tested). **Priority: P0** — it defines "does the product work".

---

## M0 — Contracts, infra, docs  (§166 STEP4, [`DECISIONS.md`](DECISIONS.md) D1–D3, D8)
Foundation so all later streams run in parallel. Target: `docker compose up` boots web+platform+ai+postgres+redis (§130).
1. **Compose + dev boot** (owner `infra/` · depends — · done: `docker compose up` starts pg16+pgvector, redis7, 3 apps; commands in README; P0).
2. **Flyway wiring to `infra/db/V1__init.sql`** (owner `services/platform` · depends 1 · done: migration applies clean on empty DB + `updated_at`/`tsv` triggers fire; P0). *Spec §84/§85 path mismatch: file is `infra/db/`, configure Flyway location accordingly ([DATABASE.md](DATABASE.md)).*
3. **Provision DB roles + grants** — create `nexus_app` (RW commerce) and `nexus_ai` (SELECT + narrow RW) as `V2__roles_grants.sql` (owner `infra/db` · depends 2 · done: `nexus_ai` INSERT into `orders` is denied by the DB, not by convention; [DATABASE.md](DATABASE.md) §9 GAP closed; **P0** — the whole §52 "no LLM→DB" guarantee depends on it).
4. **`packages/types` codegen from contracts** (owner `packages/types` · depends 2 · done: OpenAPI `/v3/api-docs` + `/ai/openapi.json` generate TS + JSON Schemas for `Intent`/`EntityCard`/`Fact`; contract test passes; [API.md](API.md); P0).
5. **LLM provider adapters + `MockAdapter` default** (owner `apps/ai/app/models` · depends 1 · done: `NEXUS_LLM_PROVIDER=mock` returns deterministic labelled intent/summary/copy offline (D4); a task_class router stub exists; P0).
6. **Auth skeleton (JWT HS256 dev, cookie) + `TenantContext`** (owner `services/platform/.../auth` · depends 2,3 · done: register/login/refresh/me round-trip; every repo requires `TenantContext`; cross-tenant → 404; [SECURITY.md](SECURITY.md) §1; P0).
7. **Docs set + AGENTS.md-of-repo conventions** (owner `docs/` · depends — · done: this 18-file set committed and internally consistent; P1).

Exit: green CI (§132): lint, type, unit, contract test, boot.

## M1 — Authentication & Merchant onboarding (§21, §22, §46–§49)
Builds merchant supply so search has something to find. Depends-on M0.
1. **Full auth: OAuth google/apple, Argon2id, refresh rotation** (platform/`auth` · M0.6 · done: [API_CONTRACT.md](API_CONTRACT.md) §3 tests pass incl. reuse detection; P1).
2. **RBAC + permission_grants enforcement** (platform · M0.3 · done: `merchant_users` roles gate every workspace route; default ai_agent read-only; denial → audit_logs; [AGENTS.md](AGENTS.md) §4; P1).
3. **Create business + verification + publish flow** (platform/`merchant` + `apps/web/(merchant)` · M1.2 · done: draft→published; unpublished invisible to search; `data_origin` set; §142 "page in 5m"; P1).
4. **Offerings CRUD + bulk** (platform · M1.3 · done: product/service/experience via `offerings.kind`; price model + freshness cols; `write_products`; P1).
5. **AI Import pipeline (async worker)** (apps/ai/`rag`+import · M1.4, M3-RAG-seam · done: URL/PDF/menu → `202 job_id` → poll → `proposals[]` with `evidence_fact_ids`; **nothing auto-published**; untrusted-content handled; [MERCHANT.md](MERCHANT.md) §2; P2).
6. **Knowledge base index + reindex-one-doc** (apps/ai · M1.5 · done: documents/chunks(embedding dim 1024)+search_tsv; targeted reindex; [RAG.md](RAG.md); P2).

## M2 — Consumer search (deterministic) (§13, §16, §113–§115)
No LLM yet — proves the retrieval/rank/geo spine. Depends-on M1 (needs published merchants + seed).
1. **Seed generator: 500 merchants / 5000 offerings / 10000 reviews, all demo-flagged** (data/seed · M0.2 · done: §86 counts, every row `data_origin='demo'`, synthetic-looking, `flags.demo`+`X-Demo-Data`; [TESTING.md](TESTING.md) §6; **P1** — the slice is untestable without it).
2. **`SearchBackend` interface + Postgres impl** (apps/ai/app/search/sql.py · M2.1 · done: hybrid tsvector ∪ trgm ∪ vector ∪ geo ∪ metadata; tenant predicate + status filter enforced; [SEARCH.md](SEARCH.md); P1).
3. **bbox + haversine geo + clustering payload** (apps/ai + platform `locations/geo` · M2.2 · done: `GET /api/v1/locations/geo?bbox&zoom`; why-no-PostGIS noted [DATABASE.md](DATABASE.md) §5; P2).
4. **`/ai/v1/search` deterministic endpoint** (apps/ai · M2.2 · done: returns `EntityCard[]` where every number has a `fact_id`; p95 <250ms warm; [API.md](API.md) contract test; P1).
5. **Ranking v1 (`hybrid_v1`)** (apps/ai/app/recommend · M2.4 · done: weighted blend, Bayesian quality, relevance floor, sponsored separation off (organic only); [RECOMMENDATION.md](RECOMMENDATION.md); P1).
6. **CJK text-search decision** (apps/ai/search · M2.2 · done: measure `tsvector('simple')` recall on zh-HK; if insufficient, enable engine `SearchBackend` or a CJK parser — resolves the [ARCHITECTURE.md](ARCHITECTURE.md) §9 risk; **P2** but blocking "real" search).

## M3 — AI search + RAG + query understanding (§7, §8, §12, §34, §116)
The intelligence layer. Depends-on M2. **Milestone M0→M3 turns on `NEXUS_LLM_PROVIDER` decision — mock in CI, real in a labelled lane [D4](DECISIONS.md).**
1. **Query understanding → `Intent`** (apps/ai/app/nlu · M2.4 · done: schema-constrained, unknowns never guessed, §8/§2 golden case passes; [AI.md](AI.md) §2; P1).
2. **Conversation state + merge rules** (nlu/state_merger + conversations.state · M3.1 · done: §34 4-turn script narrows correctly, deterministic under mock; [AI.md](AI.md) §3; P1).
3. **RAG pipeline** (apps/ai/app/rag · M1.6 · done: chunk 240–400/12% → embed(1024) → hybrid retrieve (tenant-before-similarity) → rerank top-40 → context pack w/ citations; no-answer-without-retrieval; [RAG.md](RAG.md); P1).
4. **Orchestrator plan/execute/verify** (apps/ai/app/orchestrator + tools/registry · M3.1–3.3 · done: dynamic plan, ≤6 tool/≤3 LLM budget, 4s/12s timeouts, degrade-to-deterministic on breach; [AGENTS.md](AGENTS.md) §2–3; P1).
5. **SSE streaming `/ai/v1/search/stream`** (apps/web + apps/ai · M3.4 · done: user-legible stages, no CoT, `event: error`→client deterministic fallback; first-event <1.2s; [AI.md](AI.md) §4; P1).
6. **fact_verification + fraud_trust guards in the render path** (apps/ai · M3.4 · done: claim without `fact_id` stripped; post-validation counts hallucination; [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) §4; **P0-by-consequence** (§155); P1).
7. **Eval harness + gate in CI** (apps/ai/app/eval · M3.1–3.6 · done: `intent_v1`/`rag_faithfulness_v1`/`safety_injection_v1` run; hallucination <2%, injection 100%, no >3pp regression blocks merge; [TESTING.md](TESTING.md) §5; P1).

## M4 — Recommendation + Merchant AI Agent (§17, §18, §24–§26, §55)
Depends-on M3.
1. **`/ai/v1/recommend` + stored `recommendation_sets`** (apps/ai · M3.4 · done: explanations from top features, each w/ `fact_id`; strategy versioned; [RECOMMENDATION.md](RECOMMENDATION.md); P1).
2. **`/ai/v1/compare`** (apps/ai · M4.1 · done: per-cell `fact_id`; deterministic path within budget ([PRODUCT.md](PRODUCT.md) risk); P2).
3. **Merchant sales/customer-service agent** (apps/ai/merchant-agent · M1.6, M3.3 · done: grounded in own KB only; low-confidence → handoff row + merchant notify; [MERCHANT.md](MERCHANT.md) §4; P1).
4. **Reviews AI summary with review_ids evidence** (apps/ai + platform · M2.1 · done: §55 praise/complaints trace to source reviews; no invented quotes; P2).
5. **Feedback loop** (`/ai/v1/feedback`, feedback_events · M4.1 · done: explicit+implicit+outcome combine, EMA min-3 signals, rate-limited; [RECOMMENDATION.md](RECOMMENDATION.md) §6; P3).
6. **Homepage rails (For You/Trending/…)** (apps/web · M4.1 · done: honest defaults for anonymous/cold-start ([CONSUMER.md](CONSUMER.md) risk); P3).

## M5 — Vertical slice E2E + demo env (§87–§89, §168, §170)
Depends-on M1–M4. **This closes §0 (the MVP gate).**
1. **Seed demo consumer/merchant/admin logins** (§87 · M1.1 · done: `POST /auth/demo` scoped sessions; P1).
2. **Consumer journey E2E** (§88 · all · done: search→results→compare→select→reserve→confirmation, recorded; P0).
3. **Merchant journey E2E** (§89 · all · done: signup→import→review→publish→agent answers→lead/reservation; P0).
4. **Reservation + Cart + demo checkout** (§40–§42 · M5.3 · done: real-time slot, universal cart, idempotent checkout, stale-price block, **no card data**; P1).
5. **`tests/e2e/vertical_slice.spec.ts` green** (tests · M5.2–5.4 · done: full §170 loop; P0).

## M6 — Analytics, growth & polish (§56–§64, §68, §126–§127)
Depends-on M5 (there's real signal to measure). Mostly P2–P3.
1. **Merchant analytics + AI analytics agent** (platform+apps/ai · M5 · done: §56 funnel from `v_merchant_funnel`; §57 findings/evidence read-only, no cross-merchant leak; P2).
2. **Event tracking rollout (§58)** (all · M5 · done: required event names emitted, `event_id` dedupe, north-star `v_north_star` populated; [AGENT_CONTRACT.md](AGENT_CONTRACT.md) §10; P2).
3. **Admin console (§68) + admin agent (§126)** (platform+web/(admin) · M2 · done: moderation queue, AI runs/cost views, suspend; role-gated + audited; P2).
4. **Automated moderation (§127)** (apps/ai/fraud · M6.2 · done: spam/fake-review/anomaly detection → `moderation_cases`, human-review preserved; P3).
5. **Marketing/SEO agents (draft-only) + programmatic SEO pages (§27–§30, §64)** (apps/ai+web · M4 · done: drafts land `status='draft'`, publish needs human `approve-publish`; anti-spam `quality_score`; [GROWTH.md](GROWTH.md); P3).
6. **Referral/share/collections (§59–§63)** (platform/growth · M6.2 · done: rewards fire on genuine conversion only, §110 no fake growth; P4).
7. **Cost/observability dashboards (§69–§70, §160)** (apps/ai/observability+admin · M3 · done: cost_per_search/conversation/recommendation from agent_runs/llm_calls; P4).

## M7 — Deployment (§129–§134)
Depends-on M5 (slice) / M6 (polish). **Deployment & observability have no dedicated doc (spec §85 lists them but the 18-file
set excludes them) — defined here + in [ARCHITECTURE.md](ARCHITECTURE.md) §8; a future `DEPLOYMENT.md` should be split out.**
1. **CI/CD full pipeline (§132)** (infra · M0 · done: lint→type→unit→integration→build→E2E→security-scan + **eval gate**; P1).
2. **Prod auth hardening** (platform · M1 · done: RS256 + JWKS rotation, TLS, secret store; [SECURITY.md](SECURITY.md); P1).
3. **Environments + one-command dev + `.env.example` (§129–§131)** (infra · M0.1 · done: clone→compose→run→test; no secrets committed; P2).
4. **Branch strategy + git discipline (§133–§134)** (repo · — · done: main/develop/feature/fix protected; per-slice commits; P3).
5. **Reliability posture (§104)** (platform+ai · M7.1 · done: retries, circuit breaker, timeouts, queues, idempotency; 99.9% target defined (aspirational, not measured in phase 1); P4).
6. **Self-review per §157** (all · M7.5 · done: written "what works / is fake / is placeholder / fragile / slow / expensive / breaks at 10x / 100x / should refactor" — cross-ref [ARCHITECTURE.md](ARCHITECTURE.md) §9; P3).

---

## What is explicitly NOT in Phase 1 (§169, §84 note, [`DECISIONS.md`](DECISIONS.md) D2)
Not built now, by design — revisit when the slice is real and loaded:
- Global payments / multi-country compliance beyond config hooks (§42, §128) — payments are `demo` only (D5).
- 100 countries / 20M merchants / multi-region (§147) — HK single tenant.
- Pervasive microservices (§84) — modular monolith, packages mirror future services.
- Complex Kubernetes / orchestrated infra (§169) — compose-based dev, simple deploy in M7.
- Huge ML infrastructure (§169) — pgvector in-DB, no dedicated vector DB (Qdrant/Weaviate/Milvus, §15) or warehouse
  (ClickHouse/BigQuery, §121) or Kafka (§122) until a measured bottleneck forces the seam swap.
- Full UCP/MCP external commerce (§43–§45, [UCP.md](UCP.md), [MCP.md](MCP.md)) — seams + schema only; servers land in Phase 4 (§146).
- Later verticals (travel/education/healthcare/home-services/automotive/real-estate/professional, §5) and cross-city
  expansion (§95 Phases 2–6).

## Dependency-critical notes (honest ordering)
- M2 seed (M2.1) blocks the *demonstrable* slice — search has nothing to return without it; but seed is synthetic, so the
  slice proves plumbing, not commercial truth ([VISION.md](VISION.md) risks).
- M0.3 (DB roles/grants) is P0 because the marquee safety property (no LLM→DB, [DATABASE.md](DATABASE.md) §9) is **not yet
  enforced in code or schema** — it is documentation until V2 lands.
- M3.7 (eval gate) must precede trusting any M3+ AI output; enabling live providers without it violates §156.

## Open questions / risks
- **Mock vs real provider acceptance:** with D4 mock as default, M3–M4 E2E are deterministic but don't prove real AI
  quality — schedule a real-provider eval lane (not blocking CI) before M7 sign-off ([TESTING.md](TESTING.md) risks).
- **M2.6 CJK recall** could invalidate M3–M4 relevance assumptions late; consider pulling it forward.
- **Reservations double-booking** needs the `btree_gist` exclusion constraint ([DATABASE.md](DATABASE.md) §10) before M5.4 is
  honest about "reserve".
- **No `DEPLOYMENT.md`/`OBSERVABILITY.md`** in this deliverable set (spec §85 wants them) — confirm whether they should be
  added; currently split across [ARCHITECTURE.md](ARCHITECTURE.md)/[M7](#m7--deployment-129134)/[AI.md](AI.md).
