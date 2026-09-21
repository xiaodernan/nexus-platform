# NEXUS documentation map

Read in this order if you are new to the codebase:

1. [`VISION.md`](VISION.md) — what NEXUS is trying to become, and the line it will not cross (§1-5, §150-153)
2. [`PRODUCT.md`](PRODUCT.md) — surfaces, features and MVP success tests (§140-142)
3. [`DECISIONS.md`](DECISIONS.md) — **binding** stack/layout/tenancy/honesty decisions and the local port map (D9)
4. [`API_CONTRACT.md`](API_CONTRACT.md) — the HTTP contract: endpoints, `EntityCard`/`Fact`/`Intent`, errors
5. [`AGENT_CONTRACT.md`](AGENT_CONTRACT.md) — the agent/tool/trust/ranking/RAG/eval invariants
6. [`../infra/db/migrations/V1__init.sql`](../infra/db/migrations/V1__init.sql) — the data model, then [`DATABASE.md`](DATABASE.md)
7. [`ARCHITECTURE.md`](ARCHITECTURE.md) — how the pieces run, fail and degrade (§83, §105, §157)

Contracts (4-6) and the migration are authoritative. The rest of the set explains and extends them; if prose and
contract disagree, the contract wins and the prose is a bug.

## Subsystem specs

| Doc | Covers |
|---|---|
| [AI.md](AI.md) | model router, cost accounting, failure ladder, eval |
| [RAG.md](RAG.md) | parse→chunk→embed→retrieve→rerank→pack, untrusted content |
| [AGENTS.md](AGENTS.md) | roster, orchestrator, tool registry, permissions, memory |
| [SEARCH.md](SEARCH.md) | hybrid retrieval, facets, autocomplete, ranking pipeline |
| [RECOMMENDATION.md](RECOMMENDATION.md) | candidate→filter→rank→reason→explain, personalization, feedback |
| [MERCHANT.md](MERCHANT.md) | onboarding, import, dashboard, AI agent, marketing, API |
| [CONSUMER.md](CONSUMER.md) | account, preferences, conversation, cards, compare, map, discovery |
| [GROWTH.md](GROWTH.md) | referrals, collections, creators, guides, monetization |
| [SECURITY.md](SECURITY.md) | authn/z, RBAC, injection defense, privacy, audit |
| [TESTING.md](TESTING.md) | pyramid, E2E, visual, agent eval, performance |
| [OBSERVABILITY.md](OBSERVABILITY.md) | four signals, AI replay, cost ledgers, alerts |
| [UCP.md](UCP.md) / [MCP.md](MCP.md) | external-agent surfaces and adapters |

## Execution & status

| Doc | What it is for |
|---|---|
| [ROADMAP.md](ROADMAP.md) | M0-M7 with tasks, owners, dependencies, done-when, P0-P5 |
| [TRACEABILITY.md](TRACEABILITY.md) | every spec § mapped to an artifact + verification method |
| [STATUS.md](STATUS.md) | **live** ledger: what actually runs (with the command that proved it), what is fake, and lead rulings D10-D18 on gaps found in the field |
| [DEPLOYMENT.md](DEPLOYMENT.md) | environments, compose profiles, CI/CD, one-command dev |
| [ENVIRONMENT_REPORT.md](ENVIRONMENT_REPORT.md) | audited host toolchain, occupied ports, what cannot work offline here |
| [API.md](API.md) | thin pointer to the contract + OpenAPI/contract-test workflow |

Original requirement text (Chinese, §1-§172): `../新建 文本文档.txt`.

## Doc maintenance rule

A document that describes code must change in the same commit as that code, otherwise the next agent will trust it.
Rulings that resolve a contract conflict go into `STATUS.md` first (so they are visible immediately), then into the
contract file itself.
