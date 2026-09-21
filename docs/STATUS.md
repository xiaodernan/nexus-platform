# NEXUS build status & verification ledger

Maintained by the lead agent. A line moves to `verified` only when the quoted command has been run and
its output seen. Nothing here is aspirational.

As of last update: **no work stream is finished**; 8 agents are building in parallel against the M0 contracts.

## Running services (verified by `docker ps` / queries)

| What | Where | State |
|---|---|---|
| Postgres 16 + pgvector | container `nexus-postgres`, `127.0.0.1:5433` | running, roles `nexus_app` + `nexus_ai` created, `nexus` DB has 59 tables |
| Redis 7 | container `nexus-redis`, `127.0.0.1:6380` | running (healthy) |
| throwaway verify DB | container `nexus-seed-verify`, `127.0.0.1:55432` | seed agent's sandbox — must be removed at consolidation |
| Row counts | merchants 0 / offerings 0 / reviews 0, tenants 0 | seed not loaded yet |
| Platform :8080, AI :8000, Web :3000 | — | not up yet |

Ports are fixed by `docs/DECISIONS.md` §D9 because this machine already runs unrelated stacks on 5432/6379
(`careeros-postgres`, `specproof-*`). Do not bind those.

## M0 contracts

| Artifact | State | Evidence |
|---|---|---|
| `infra/db/migrations/V1__init.sql` | committed `7591852`, applied to `nexus` DB | `\dt` = 59 tables |
| `docs/API_CONTRACT.md` | committed | consumed by platform/ai/web/sdk/e2e |
| `docs/AGENT_CONTRACT.md` | committed | consumed by ai/web/e2e |
| `docs/DECISIONS.md` + `README.md` + `docs/TRACEABILITY.md` | committed / in tree | — |
| `tests/e2e` harness (playwright config + 4 suites) | written by lead, **not yet executed** | needs :3000/:8000/:8080 |

## Reconciliation items (must close before M1 commit)

1. **Embedding dimension.** Contract says `vector(1024)`; the seed agent reported switching the table to
   384 for a local small-embedding model, while the current migration file still reads 1024. Pick one value,
   make it a single source (`NEXUS_EMBED_DIM` + the column in V1), and align `HashingEmbedding` in the AI
   service. A mismatch = every RAG insert fails at runtime, so this is P0.
2. **Migration ownership.** Infra + platform both apply `V1__init.sql`; Flyway `locations` must point at
   `infra/db/migrations` (or a copy step) with no second divergent copy of the DDL.
3. **`nexus-seed-verify` container** must be removed once `nexus-postgres` is the shared DB.
4. **Demo tenant UUID** must be the documented stable value in every stream (`00000000-0000-0000-0000-000000000001`).
5. Each agent's self-declared "gaps" list gets appended here verbatim-then-verified as they report.

## Definition of done for the vertical slice (§170)

`make dev-stack` then `npm test` in `tests/e2e` green, with screenshots of `/`, `/search`, `/m/[slug]`,
`/merchant`, `/admin` in `tests/evidence/`, plus one eval run report showing hallucination rate < 2%.
