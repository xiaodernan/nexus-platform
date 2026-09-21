# NEXUS — Binding architecture decisions (Phase 1)

Written by the lead agent. Parallel work streams must follow these; changes go through this file first.
Contracts: `docs/API_CONTRACT.md` (HTTP), `docs/AGENT_CONTRACT.md` (agents/tools/trust), `infra/db/migrations/V1__init.sql` (data).

## D1 Stack (from §80-82, adapted to this machine)
| Layer | Choice | Version pinned | Port |
|---|---|---|---|
| Frontend | Next.js App Router + TypeScript + Tailwind CSS + Framer Motion + shadcn-style primitives (hand-written, no CLI network dep) | Next 15.x, React 19, TS 5.x | 3000 |
| Commerce core | Java + Spring Boot modular monolith, Maven, Flyway, Spring Security, JPA | Spring Boot 3.5.x, Java 25 (Temurin) | 8080 |
| AI service | Python + FastAPI + Pydantic v2 + asyncpg + httpx | Python 3.11, FastAPI ≥0.115 | 8000 |
| Data | PostgreSQL 16 + pgvector, Redis 7 | images `pgvector/pgvector:pg16`, `redis:7.4-alpine` | 5432 / 6379 |
| E2E | Playwright | latest | — |
| Package mgmt | npm workspaces (pnpm is not installed on this machine) | — | — |

## D2 Repository layout — deliberate deviation from §84
```
apps/web          Next.js app: (consumer) + (merchant) + (admin) route groups — one deployable, not three
apps/ai           FastAPI agent/RAG service
services/platform Spring Boot modular monolith (not microservices yet, per §84 note)
packages/types    shared TS types + JSON Schemas generated from the contracts
infra/            compose, db migrations, config (ranking weights, i18n)
data/seed         synthetic dataset generator + loader
tests/e2e         Playwright suites + evidence artifacts
docs/             contracts + design docs
```
Rationale: three Next apps would duplicate the design system and triple CI time for zero phase-1 value; §84 explicitly
permits a monolith while the team is small. `services/*` (user/merchant/search/...) exist as **Java packages** inside the
monolith, mirroring the target service split so extraction stays mechanical later.

## D3 Search & vector
- Phase 1 = Postgres only: `tsvector('simple')` + `pg_trgm` + `pgvector` HNSW + bbox prefilter then haversine
  (no PostGIS in the chosen image). SQL lives in `apps/ai/app/search/sql.py` and `services/platform/.../search/`.
- Behind a `SearchBackend` interface so OpenSearch/Elasticsearch can be added without touching call sites (§16).
  Images are already cached locally if we enable it: `elasticsearch:8.13.4`.
- Embedding dim **1024** everywhere (`chunks.embedding vector(1024)`). Changing dim = new migration, not a config edit.

## D4 LLM providers
`NEXUS_LLM_PROVIDER` ∈ `mock | anthropic | openai`. Default **mock**: deterministic heuristic implementations of every
LLM task (intent extraction, summary, copy generation) so the whole product runs offline and CI is stable — clearly
labelled `"provider":"mock"` in responses and in the UI badge. Real providers configured via
`NEXUS_LLM_BASE_URL` / `NEXUS_LLM_API_KEY` only. Never commit secrets (§131). No feature may claim a live model in docs
unless `NEXUS_LLM_PROVIDER!=mock`.

## D5 Auth & tenancy
- Stateless JWT (HS256 in dev via `NEXUS_JWT_SECRET`, RS256 in prod) + HttpOnly `nexus_session` cookie set by the
  platform service and read by Next via server components. No card data ever stored (§42); payment provider is a
  `PaymentProvider` interface with a `demo` implementation.
- Every tenant-owned table carries `tenant_id`; repositories must take `TenantContext` as a first argument and add the
  predicate — a query without a tenant filter fails review. Cross-tenant access returns 404, not 403 (no enumeration).

## D6 Honesty rules baked into code (§109, §155)
- `data_origin`/`flags.demo` is set to `demo` by every seed/import path and rendered as a badge in UI + `X-Demo-Data`
  header on API responses from demo rows.
- Synthetic data must look synthetic: invented merchant names, `example.*` domains, `DEMO` markers.
- No endpoint fabricates availability, ratings, prices or traffic. Empty state is a valid, designed state.

## D7 Definition of done for every work stream
1. Code compiles and runs in this environment (commands recorded in README).
2. Unit + integration tests pass; `docs`-contract test passes for anything touching HTTP shapes.
3. UI work verified in a real browser with a screenshot saved under `tests/evidence/`.
4. No TODO stub that pretends to work — unimplemented paths raise `NotImplementedError`/501 with a clear message.

## D8 Milestones (§167)
M0 contracts+infra+docs → M1 auth & merchant onboarding → M2 consumer search (deterministic) → M3 AI search+RAG →
M4 recommendation+merchant agent → M5 vertical slice E2E → M6 analytics/growth polish → M7 deployment.
Vertical slice (§168) is the acceptance target; anything not on that path is deferred.

## D9 Canonical local ports (BINDING — this machine already runs other projects on 5432/6379)
| Service | Container/port | Host port | Why |
|---|---|---|---|
| Postgres (pgvector) | `nexus-postgres` | **5433** | 5432 is occupied by an unrelated `careeros-postgres` |
| Redis | `nexus-redis` | **6380** | 6379 is occupied by an unrelated `specproof-redis` |
| Platform (Spring Boot) | host process | 8080 | free |
| AI service (FastAPI) | host process | 8000 | free |
| Web (Next.js) | host process | 3000 | free |

Default dev connection strings come from `.env` (git-ignored, §131: dev credentials are never written into
tracked docs): `NEXUS_PLATFORM_DB_URL` = `postgresql://nexus_app@127.0.0.1:5433/nexus`, `NEXUS_AI_DB_URL` =
`postgresql://nexus_ai@127.0.0.1:5433/nexus`, `NEXUS_REDIS_URL` = `redis://127.0.0.1:6380/0`. Container-internal
hosts are `postgres:5432` / `redis:6379`. Test database: `nexus_test` on the same container. Demo tenant slug is
`hong-kong` with the stable id `00000000-0000-0000-0000-000000000001`. Agents must not invent other host ports and
must not touch the non-Nexus containers.

