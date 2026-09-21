# NEXUS

AI-native commerce & local discovery platform. Consumers say what they want in natural language;
NEXUS understands, searches, compares and recommends. Merchants get an AI business agent that does
discovery, customer service, marketing, SEO and analytics on top of their own data.

First market: Hong Kong. Architecture target: global-ready. Current phase: **MVP vertical slice**.

## Status

This repository is under active construction. Read the contracts first — they are the source of truth,
this README is only the door.

| Area | Path | What it is |
|---|---|---|
| Binding decisions | [`docs/DECISIONS.md`](docs/DECISIONS.md) | stack, layout, tenancy, honesty rules, definition of done |
| HTTP contract | [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) | every endpoint + `EntityCard`/`Fact`/`Intent` shapes |
| Agent contract | [`docs/AGENT_CONTRACT.md`](docs/AGENT_CONTRACT.md) | agents, tool registry, trust layer, ranking, RAG, eval gate |
| Data model | [`infra/db/migrations/V1__init.sql`](infra/db/migrations/V1__init.sql) | authoritative DDL (Postgres 16 + pgvector) |
| Design docs | [`docs/`](docs/) | vision, architecture, database, ai, rag, agents, search, merchant, growth, security, testing, ucp, mcp, roadmap |
| Environment audit | [`docs/ENVIRONMENT_REPORT.md`](docs/ENVIRONMENT_REPORT.md) | what this machine actually has |

## Modules

```
apps/web            Next.js 15 — consumer (merchant dashboard + admin land here too, route groups)
apps/ai             FastAPI — query understanding, hybrid search, RAG, agent orchestrator, eval, UCP/MCP
services/platform   Spring Boot modular monolith — identity, merchant, catalog, commerce, payments, events
packages/ui         design system primitives + EntityCard/fact-rendering components
packages/types      shared TS types + JSON Schemas generated from the contracts
infra               docker compose, Flyway/SQL migrations, ranking weights, DB roles
data/seed           synthetic Hong Kong demo dataset generator
tests/e2e           Playwright suites; tests/evidence holds screenshots of every verified UI change
```

## Quick start

```bash
cp .env.example .env          # fill nothing for the mock/demo path
make infra-up                 # postgres (pgvector) + redis
make db-migrate seed          # schema + synthetic demo data
make dev-platform             # :8080  commerce core
make dev-ai                   # :8000  AI service
make dev-web                  # :3000  consumer app
```

`NEXUS_LLM_PROVIDER=mock` (default) runs the whole product offline: intent extraction and summaries use
deterministic heuristics, and every response is labelled degraded. Point `NEXUS_LLM_BASE_URL` +
`NEXUS_LLM_API_KEY` at an Anthropic- or OpenAI-compatible endpoint to enable real models. No secret is
ever committed.

## Non-negotiable product rules

- Real data or nothing: every price, rating, hour and distance shown to a user traces to a `facts` row
  with `source`, `confidence`, `observed_at`, `expires_at`. Unverifiable = rendered as unverified.
- Synthetic demo data is labelled demo. Fake reviews, fake merchants, fake prices, fake traffic are
  prohibited.
- Organic ranking never reads spend. Sponsored entries are inserted after organic scoring and labelled.
- AI agents act through the tool registry with explicit permission grants — never directly against the
  database, never with self-escalated scope.
- Marketing/SEO output is generated as drafts; publishing requires an explicit human action.
- If a model fails: fallback model → deterministic search → human handoff. The site never goes dark
  because an LLM did.

## Acceptance target

The MVP is complete when this runs end to end against real rows (spec §170): consumer asks
"帮我找一个适合情侣约会的地方" → intent understood → hybrid search → RAG → ranking with verifiable
explanations → merchant page → merchant AI answers from its own knowledge base → lead/reservation/cart
→ analytics on the merchant side.

See `docs/ROADMAP.md` for the milestone breakdown.
