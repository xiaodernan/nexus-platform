# NEXUS build status & verification ledger

Maintained by the lead agent. A line moves to `verified` only when the quoted command has been run and
its output seen. Nothing here is aspirational.

As of last update: **no work stream is finished.** Infra, SDK, docs, types, UI-kit and seed streams are
done; the platform, AI-service and consumer-web streams each hit their turn budget mid-build (see
"Stream states at the turn ceiling") and are being rebuilt in smaller increments.

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

1. **Embedding dimension — resolved at 1024, after two agent reports claimed otherwise.**
   `infra/db/migrations/V1__init.sql:522` says `vector(1024)` and `pg_attribute.atttypmod` reports 1024 on both
   `nexus` and `nexus_lead_check`. The seed stream twice reported having switched the shared file to 384; that edit
   was never applied, and the AI stream switched `HashingEmbedding` to 384 on the belief that it was. **The contract
   value 1024 stands**; the AI service must emit 1024-dim vectors or every RAG insert fails on a dim mismatch. The
   `chunks_embedding_dim_guard` trigger is the tripwire that makes this loud instead of silent.
   **Adjudicated by direct measurement, re-run twice:** `grep` shows `V1__init.sql:522 = vector(1024)` and
   `pg_attribute.atttypmod = 1024` for `chunks.embedding`. The AI stream asked for a V3 `ALTER ... TYPE vector(384)`
   on the belief that the file said 384 — that ALTER must **not** land; the AI service's `NEXUS_EMBEDDING_DIM`
   default changes to 1024 instead. Lead action at integration: patch the config default, delete any V3 dim ALTER,
   re-run the RAG eval.
2. **Migration ownership** — resolved: single stream `infra/db/migrations/V*.sql` applied by
   `scripts/db_apply_migrations.sh`; V1 + V2 verified applying cleanly (58 tables, `ON_ERROR_STOP=1`) on a
   scratch database `nexus_lead_check`. A stray duplicate `infra/db/V1__init.sql` was deleted.
3. **`nexus-seed-verify` container (55432)** — still needed by the seed stream for parallel verification;
   remove at consolidation, not before.
4. **Demo tenant UUID** `00000000-0000-0000-0000-000000000001` — now documented in `infra/db/seed/README.md`.
5. **Contract drift reported by the AI stream (all real, resolved below as D10-D12).**

## Lead rulings on contract gaps

| # | Gap found in the field | Ruling |
|---|---|---|
| D10 | `availability` had two definitions: `resource_pools` vs `slots.capacity_left` (no pools are seeded) | `available ⇔ EXISTS(slot WHERE capacity_left > 0 AND starts_at = requested_time)`; `resource_pools` is a slot **template**, never a query predicate. AGENT_CONTRACT §4/§5 updated. |
| D11 | `GET /api/v1/merchants/{id}/availability` had no owner and no response shape | Platform owns it as a projection over `availability_slots`, same semantics as D10, `Cache-Control: no-store`. |
| D12 | AI stream needs `conversations`/`messages`/`handoffs` writes, which §0 assigned to the platform | `conversations`, `messages`, `handoffs` move to the AI service's write set (it is the only writer of agent-path dialogue). Platform keeps read access for dashboards and owns everything else. Two writers on one table is the actual bug. |
| D13 | §7 named `/api/v1/ai/chat` + an `agent_run` SSE event that no table backs | Canonical stream is `POST /ai/v1/search/stream` (web BFF proxies at `/api/nexus/ai/stream`); stream events are exactly `intent \| status \| results \| summary \| error \| done` with `agent_run_id` inside `done`. `GET /ai/v1/conversations/{id}` returns the `agent_runs` timeline. |
| D14 | MCP advertises `check_availability`, registry names it `get_availability` | `check_availability` is an MCP-adapter alias only; one implementation, declared in the tool manifest. UCP is served at host root `/.well-known/ucp` with per-merchant `.../ucp.json`. |
| D15 | `GET /api/v1/merchant/businesses/{id}/overview` in §5 has no §9 data source | Analytics module owns it, backed by `v_merchant_funnel`. |
| D16 | Role provisioning lived only in container init scripts (fresh Flyway DB had zero roles) | Infra moved role/grant statements into the migration stream + `db_apply_migrations.sh` step 2, keeping `infra/postgres/init/00_roles.sql` as the container path. |
| D17 | Infra stream proposed a new `V4__identity.sql` for `users`/`user_identities`/`user_preferences`; seed stream proposed a V-migration converting `chunks.embedding` to `vector(384)` | **Both rejected.** `V1__init.sql` contains 56 tables including all three (verified by grep and by `information_schema` on the live `nexus` DB); the "11 tables" the infra stream saw was a `citext`-aborted partial apply, now fixed. And the live column is `vector(1024)`, matching the contract. A V4/V5 adding those objects would fail on `CREATE TABLE users` already exists, or silently fork a second definition — if either migration appears, delete it and re-run `scripts/db_apply_migrations.sh`. |
| D18 | `GET /api/v1/merchants/{id}/availability` (§4) has no implementation anywhere: the platform stream built reservation booking + capacity decrement but not the public availability read; the AI stream implemented the equivalent as an internal search filter | Platform owns it (D11). Deferred to the integration pass with an explicit owner; the seed stream offered to write it — accepted only as a reference SQL implementation to review, not as a second service. |

| D19 | Infra finished and reported that `nexus_ai` has no access to `tenants`, `user_preferences`, `events` — so `get_user_preferences` and `record_event` could not run as written in AGENT_CONTRACT §1 | Grants amended in `infra/postgres/init/00_roles.sql` and re-applied to the live DB (verified: 23 tables for `nexus_ai`): + SELECT `tenants` (market config), + SELECT `external_principals` (MCP caller resolution), + SELECT `user_preferences`, + **INSERT-only** `events`. Two measured consequences are written into that file: (1) `INSERT ... RETURNING` is rejected with INSERT-but-no-SELECT, so the event writer must not use RETURNING; (2) the earlier blanket `ALTER DEFAULT PRIVILEGES ... TO nexus_ai` leaked SELECT over users/carts/orders and is now revoked fail-closed. Preference *writes* stay with the platform (`/api/v1/me/preferences`), so one actor owns one table. |
| D20 | D12 said the AI service should own `conversations`/`messages`/`handoffs`; the platform instead built one guarded write door (`POST /api/v1/internal/conversations/{id}/agent-message`, `X-Internal-Token`, 501 when unconfigured) and the AI service had not written any dialogue SQL yet | **The platform door wins; D12 is superseded for those three tables.** Rationale: the AI service executes LLM output and is the least trusted writer in the system (§51/§52), and a second SQL path around the door is exactly the unaudited write D12 was meant to prevent. `nexus_ai` therefore gets **no** grant on those tables (verified absent), and API_CONTRACT §7.0 documents the two service-to-service paths (`agent-message` in, `/ai/v1/imports/extract` out, which the platform's `HttpImportAdapter` already calls). |
| D21 | AGENT_CONTRACT §1 lets the marketing agent draft coupons, but D19's grant list had no `coupons` | `coupons` added to the AI read-write set (drafts only — §27 publish still requires the human `approve-publish` call, which is platform-side). Found by cross-reading the roster table against the grant list, not by a runtime failure. |

## Route coverage ledger (machine-generated, not opinion)

`node scripts/check_contract_drift.mjs` parses every path in `docs/API_CONTRACT.md`, then looks for it in
the real implementations. Last full run (lead, before the current build wave):

| Bucket | Count | Meaning |
|---|---|---|
| Documented routes parsed | 92 | every row of §3-§10 |
| Served by platform/ai | 45 | a handler exists in `services/platform` or `apps/ai` |
| **CLIENT-ONLY** | 39 | SDK/web calls it, no service answers — a working-looking button that 404s |
| **MISSING** | 4 | nobody references it at all |
| **UNDOCUMENTED** | 1 | code names a path the contract never defines |

The 4 MISSING are one family, and that family has no builder since the platform stream stopped:
`/api/v1/referrals/invite`, `/api/v1/referrals/me`, `/api/v1/referrals/me/stats` (§61-62 growth),
`/api/v1/merchant/customers` (§23/§56). The 1 UNDOCUMENTED is `POST /api/v1/events` — the SDK batches
telemetry there (§58) and the contract never gave it a row. Lead owns all six; CI runs the checker in
report mode now and must flip to failing mode at M4 (§156).

## Stream states at the turn ceiling (2026-09-22, measured not claimed)

Three build streams stopped because they hit their 150-turn budget, not because the work was done:

| Stream | State on disk | Verified by |
|---|---|---|
| platform | 76 main sources, compiles (`mvn -o compile` BUILD SUCCESS), 5 test classes, **`mvn -o test` fails 17 of 22** — 422 channel enum mismatch, a 500 on the internal agent-message door, notification preference validation + an unauthenticated inbox call | lead run at 01:05 |
| ai-service | 29 python modules: config/contract/models (router+mock+embeddings)/nlu/search SQL — stopped before the trust layer and before any HTTP router | drift scan + file listing |
| web | `package.json`, tailwind/eslint/vitest config, 64 SVG media assets, and `src/lib/**` (types, api base, env, facts, format, mock) — **zero pages, zero components** | `find apps/web/src` |

Consequence for the plan: the vertical slice (§166-168) cannot be browser-verified until web has pages and
the AI service has a routable `/ai/v1/search/stream`. The lead rebuilds those two in small, provable
increments rather than one long stream.


## Definition of done for the vertical slice (§170)

`make dev-stack` then `npm test` in `tests/e2e` green, with screenshots of `/`, `/search`, `/m/[slug]`,
`/merchant`, `/admin` in `tests/evidence/`, plus one eval run report showing hallucination rate < 2%.
