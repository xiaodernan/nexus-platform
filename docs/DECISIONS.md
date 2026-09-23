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


## D22 D9 was wrong about two containers on this machine — measured 2026-09-22

D9 pinned Postgres to the container name `nexus-postgres` on host port 5433. Both halves of that claim are
false on the current machine, and the build has been quietly working around it:

| Claim | Measured |
|---|---|
| `nexus-postgres` is ours | `docker inspect -f '{{json .Config.Labels}}' nexus-postgres` → `com.docker.compose.project.config_files = D:\内容创作平台\infra\docker-compose.yml`. Another project owns that name **and** that volume (`nexus-pgdata`, superuser `nexus`, `nexus` DB with 29 unrelated tables: design_nodes / games / remixes). It publishes host port **55433**, not 5433. |
| Our Postgres answers on 127.0.0.1:5433 | Until today nothing did. `nexus-redis` (ours, `获客平台\infra`) is the only Nexus store the compose file has ever successfully started; `docker compose up postgres` fails on the container-name conflict, so our stack has never had its own database container running. |
| "the `nexus` DB has 59 tables" (STATUS, older revision) | Not reproducible anywhere: 5433 is a manual `nexus-platform-testpg` container whose only Nexus DB is `nexus_test` (58 tables, roles `nexus_app` + `nexus_ai` — provisioned by the platform stream); 55432 `nexus-seed-verify` has user `nexus`, DB `nexus`, **0** public tables; 55433 is the other project's. The earlier number was measured against a container that no longer exists and was never re-checked. |

Rulings, binding for every stream:

1. **Never create, stop, exec into or drop anything belonging to `nexus-postgres`, `careeros-*`,
   `specproof-*`, `football_os_db`, or `content-creation` stacks.** They are the user's other projects.
2. Our compose service must stop claiming the colliding name. `infra/docker-compose.yml` gets
   `container_name: nexus-platform-postgres` (project `nexus`, volume `nexus_pgdata` — both already unique),
   and every script that does `docker exec nexus-postgres` (`Makefile`, `scripts/db_apply_migrations.sh`,
   `data/seed/load.sh`, `data/seed/quality.sql`) follows in the same change, or the scripts will drive a
   container that is not ours. **This edit is deliberately sequenced after the DB stream's current work on
   `infra/**` and `data/seed/**`** — two writers on those files is how the D17 phantom migrations happened.
3. Until (2) lands, the canonical dev database is whatever container answers 127.0.0.1:5433, and today that
   is `nexus-platform-testpg`. It is **not** compose-managed and its data lives in the container layer, so
   anything loaded into it must be treated as re-creatable, not durable: seed data loaded there has to be
   re-loadable from `infra/db/seed/` by script, and no stream may treat its contents as a migration source.
4. D9's "Web host port 3000" is also stale on this machine: 3000 is occupied by another project. Dev is
   3001, the lead's production verification server is 3002. CI may keep 3000 because a runner is empty.
5. Ledger discipline, from §157: a STATUS row that quotes a port or a container name is a claim about a
   machine, and machines change. Rows of that kind carry the date they were re-measured, and the re-measure
   is `docker ps` + one query — not `grep` over our own docs.
6. Ruling (2) landed on 2026-09-22: the compose project is `nexus-platform` and its containers are
   `nexus-platform-postgres` / `nexus-platform-redis`. The first `docker compose up -d postgres` under the
   old `name: nexus` **removed the other project's `nexus-postgres` container** (both compose files declared
   the same project name, so `up` reconciled their stack away from it). It was restored from that project's
   own compose file with its `nexus-pgdata` volume intact — 29 tables re-counted afterwards. Recorded here
   because §157 asks for the near-miss, not just the outcome: a shared container name is a destructive
   dependency, and `docker compose up` on a file that collides is not a read-only action.
7. The D9 host-port pin is wrong for the application tier too, measured 2026-09-22 with
   `netstat` + `Get-CimInstance Win32_Process`:
   | Port | Owner (command line) | Consequence |
   |---|---|---|
   | 8080 | `java -jar target/career-os-backend-0.1.0.jar` | not ours |
   | 8000 | `python -m uvicorn app.main:app --port 8000` | not ours |
   Both belong to the AI Career OS stack. `application.yml` keeps `${NEXUS_PORT:8080}` and the AI keeps
   `8000`, because those are the contract's defaults and a CI runner is empty; locally the platform runs
   with `NEXUS_PORT=8090` and the AI with its own `--port 8010`, and `infra/docker-compose.yml` already
   exposes `NEXUS_PLATFORM_HOST_PORT` / `NEXUS_AI_HOST_PORT` for exactly this. Never kill or re-bind those
   two processes; a `404` from `:8000/ai/v1/health` is a different app answering, not our service being
   broken — check the responder's identity before diagnosing.

## D23 The AI service had never met a real database — three dead paths, found on 2026-09-22

`apps/ai` was green for days: `pytest -q` reported 64 passed. Four of those tests were the live-DB suite,
and every one of them **skipped itself** because `NEXUS_TEST_DATABASE_URL` was unset. With the seed loaded
(STATUS "Seed dataset"), they ran, and three things that had never actually worked came out:

| # | Symptom measured | Cause | Fix |
|---|---|---|---|
| 1 | `GET /ai/v1/health` → `{"database": {"configured": true, "available": false, "error": "syntax error at or near \"ONLY\""}}` | `Database.readonly()` opened its read-only transaction with `SET LOCAL READ ONLY`, which is not Postgres syntax. **Every** read through that method failed, so live search could only ever return an empty list. | `SET TRANSACTION READ ONLY`, which is the accepted form and is legal as the first statement of the block. |
| 2 | `agent_runs` insert rejected: `null value in column "started_at" violates not-null constraint` | Callers time a run off a monotonic clock and pass `started_at=None`; the INSERT bound that NULL explicitly, overriding the column's `DEFAULT now()`. `persist_run` swallows the failure, so the §52 audit ledger was silently empty in live mode and only `ledger.persisted=false` hinted at it. | Derive `started_at` from the measured `latency_ms` in the INSERT, and leave an explicit value authoritative via `COALESCE`. |
| 3 | `POST /ai/v1/search` with a categorised query → `items: []` while the same SQL without the category filter returned 60 candidates | The NLU answers with a coarse bucket (`restaurant`, `escape_room`, `retail`) and the filter compared it to `merchants.category_primary`, a display label ("Ramen · Sha Tin"). No live row can match; the offline fixture hid it because its catalogue stores the bucket itself. | `nexus_ai/search/categories.py` resolves a bucket to taxonomy slugs and the builders match through `merchant_categories`/`categories` (one tree level). Needs `SELECT` on those two tables for `nexus_ai`, so `00_roles.sql` and API_CONTRACT §0 gained them; `seed/quality.sql` now forbids a `category_primary` that is not one of the merchant's own category names, which is what kept the district baked into the label. |

Rulings:

1. **A skipped test is not a passing test.** `pytest -q` excluding `integration` is fine as the default, but
   the CI job must run `NEXUS_TEST_DATABASE_URL=... pytest -m integration` whenever a service database is up,
   or the read path, the audit ledger and the category filter can each be dead and the suite still says green.
2. Two buckets deliberately have no counterpart in the 77-node taxonomy (`cinema`, `medical`, `footwear`,
   `electronics`, `tutoring`). They resolve to themselves and match nothing, which returns an honest empty
   page; inventing a mapping to keep a demo pretty is the §109 failure mode in a new place.
3. `tests/test_search_sql.py` pins the resolver and asserts the candidate SQL walks the taxonomy tables, so
   the string-equality bug cannot come back through a refactor of the demo path.

## D24 §4 consumer reads ride the one card projection — 2026-09-22

`GET /api/v1/merchants/{id_or_slug}` was the vertical slice's blocker: the route existed in the contract and in
`apps/web`, and answered `404 "No such endpoint"`. `com.nexus.catalog` now serves all six §4 merchant reads
(14 tests in `CatalogReadTest`, 61/61 green, each route re-read live against the seed — STATUS "Consumer catalog
reads"). Five rulings came out of writing them:

1. **One projection, not two.** The directory list, the profile and the §29 SEO page are all `MerchantCards.COLUMNS`
   + `LATERAL_JOINS` + `card()`. A second merchant `select` is how "4.6 · 213 reviews" starts meaning different
   things on two pages; the profile is the card plus its own extra keys, and the test asserts the *same* `fact_id`
   appears on the list card and on the profile.
2. **Filter on the column the card prints.** `district` compares `locations.district` (the primary location), not a
   text search, so "what you filter is what the card says". `category` answers the printed `category_primary` name,
   a taxonomy leaf slug/name **and** its parent — the D23 lesson, and the reason `?category=Hot%20Pot` and
   `?category=hotpot` return the same 25 merchants, including one that calls itself Indian: its own
   `merchant_categories` link puts it in that aisle and the card still prints its own primary. An unseeded slug
   returns 0 rather than being fuzzy-matched into a result.
3. **Unknown is not cheap, and absent is not empty.** `avg_price_hkd IS NULL` fails `max_price` (and
   `rating_agg`-less rows fail `rating`) because "we do not know" must not satisfy "HK$200 or less". A draft, a
   suspended, another tenant's or an unknown merchant is `404 merchant_not_found` on every one of the six routes,
   and a not-yet-generated AI summary is `404 review_summary_not_found` — "no summary exists" and "this place has no
   reviews" are different facts, and the second one's real answer is `review_stats.published_reviews = 0`.
4. **A bare sort token is ascending, everywhere.** `Paging.orderBy` appends `asc` unless the token starts with `-`, so
   the whitelist holds bare column fragments and the endpoint defaults are stated in full (`m.popularity_score desc
   nulls last`) — "least popular first" is not a default anyone asked for. `rating_agg`/`popularity_score` are
   `NOT NULL DEFAULT 0`, so a merchant nobody rated simply has the lowest rating there is — it leads `sort=rating`
   and trails `sort=-rating`, and only `nulls last` makes a genuinely nullable column (an unknown
   `avg_price_hkd`) sink. No fragment reads `plan`, campaign, coupon or spend,
   and the profile does not echo `plan` at all (§66).
5. **A price is an object, a fact is a number, and a cached seat is a lie.** Money goes out through `Json.money`
   (`"136.70"` + currency); `confidence`, `average_rating` and `share` are JSON numbers, which is why the first test
   run failed on `"0.900" != 0.9` — the contract's money-string rule does not extend to a scale. Availability answers
   `Cache-Control: no-store` because a seat is a claim about a moment someone else may take a second later (§20),
   and its `price`/`offering` stay `null` on seeded slots rather than borrowing the pool's price (§19).

Side effect worth keeping: this pass cleared the ledger's last 4 MISSING and its 3 UNDOCUMENTED rows — the two AI
routes it turned up (`GET /ai/v1/health`, `GET /ai/v1/conversations/{id}`) are now documented from the payloads the
running service returns, with the conversation read's missing tenant predicate recorded as a known limit rather
than papered over.

## D25 A rendered claim needs a fact row — the hours case — 2026-09-22

The vertical slice's merchant page read `/api/v1/merchants/{slug}` and cast the payload straight into
`MerchantDetail`. The cast was a lie of omission: `price` is an object on the wire and a string in the view-model,
`business_hours` numbers weekdays `0=Mon…6=Sun` while the page labels `0=Sun…6=Sat`, and `price_model`
`from_price` is not a `PriceModel` the UI knows. The page rendered blank fields in live mode and full ones in mock
mode, which is the one comparison that makes fake data look like progress (§109). `apps/web/src/lib/platform-catalog.ts`
is now the only place that crosses those conventions; `data.ts` projects through it and casts nothing.

Three rulings came out of it, and all three change what the platform owes a card:

1. **A computed badge still needs a fact to cite.** `open.is_open` is derived at query time from
   `business_hours`, so it was emitted with `source_fact_id: null` — the §19 rule says a rendered claim resolves to
   a `Fact`, and "open now" is a claim. `MerchantCards` now joins the merchant's newest
   `f.attribute = 'opening_hours'` row into every card (`hf` lateral) and names its id from `open`. This is
   presentation, not a new fact: the row and the boolean are the same statement read from the same table.
2. **The write must keep the mirror true.** `opening_hours` (stored) and `business_hours` (rendered) are one claim in
   two vocabularies; `@nexus/ui/trust/fact.ts` now resolves them through an alias table, mirroring the TTL table
   `apps/ai/nexus_ai/trust/freshness.py` already keeps. `MerchantService.addHours` did write a fact, but only the
   interval being edited (`{weekday, opens_at, closes_at}`), a second shape nothing else in the system produces: the
   seeded rows carry `{zones: […], closed_weekday}`, and `hoursFactText` can only decode that one, so a merchant edit
   replaced a legible week with an unrenderable fragment. It now records the merchant's whole week, which is also
   what `open` is computed from — a citation must not be narrower than the claim it supports. The route this needed
   arrived the same day from the merchant-console stream: `MerchantContentController` reaches `addHours` through
   `POST`/`PATCH /api/v1/merchant/businesses`, so the mirror is now HTTP-reachable — and `com.nexus.merchant` still
   ships no integration test, which D26 records as the open half of that surface.
3. **`demo` is a source, not a mistake.** 520 seeded hours rows carry `facts.source = 'demo'`, which §2's union did
   not include. `apps/ai` resolved that by clamping unknown sources to `inferred` — provenance laundering, the
   opposite of §109. `demo` is now a first-class `FactSource` ranked below `inferred` (ui, `apps/ai`,
   `packages/types`, API_CONTRACT §2, DATABASE.md), with a confidence cap of 0.5, so synthetic data states where it
   came from and never outranks a real observation.

Deliberately not done: no `rating` fact row exists for any seeded merchant, so the live card keeps rendering
未验证 for the rating number. Materialising one from `review_stats` is a data decision (§19), not a projection
fix, and inventing it in TypeScript is exactly what this task was cleaning up.

## D26 A hold is released by whoever took it — the reservation cancel ruling — 2026-09-22

§6 of the API contract lists `PATCH /api/v1/reservations/{id}` with the note "status transitions guarded" and
defines no body, no actor and no target state. The route did not exist. That gap was not cosmetic: the consumer
slice could reach a booking and had no way out of it, so `NX-RES-A5DMBX` — the demo hold `docs/STATUS.md` records
as left in the developer database — is stuck holding two of five seats with no route that can return them.

Five rulings, each driven by something the code did rather than by taste:

1. **The route offers exactly one transition, to the person it belongs to.** `pending`/`confirmed` → `cancelled`,
   for the authenticated holder (`reservations.user_id` against the token's subject, never against
   `contact.email`). Anyone else gets `404 reservation_not_found`, per D5: a route that answers 403 to a stranger
   lets anyone test whether a booking code exists. This is the smallest reading of "transitions guarded" that
   does not require inventing an actor the workspace vocabulary cannot name (see 3).
2. **A release follows the same rule as a claim.** `ReservationService.cancel` guards on
   `status in ('pending','confirmed')` inside the update, so a double-tapped cancel returns the seats once; the
   replay answers 200 and deliberately omits `slot` rather than printing a seat count for a change it did not
   make. Seats go back in the same transaction, clamped by `least(capacity_left + party_size, capacity_total)`
   because a merchant who shrank the pool mid-evening would otherwise make the restore fail
   `availability_slots_capacity_bounds` — a booking that cannot be released cleanly is worse for the diner than a
   slot one seat short of its new total.
3. **Merchant-side advancement is not implemented, and is a contract question, not a code gap.** Nothing in §5's
   permission vocabulary means "change somebody else's booking": `read_orders` is a read, `create_reservation` is
   a claim. Granting a write through either would be §52's forbidden step (a write with no matching permission),
   and minting `manage_reservations` is a vocabulary change with grant-set consequences. Ruled: refuse, and record
   it — `POST /api/v1/orders/{id}/cancel` has the same shape problem on the commerce side.
4. **`completed` and `no_show` are records, not holds.** They answer 409 `reservation_not_cancellable`: rewriting an
   evening that already happened into a cancellation would falsify the merchant's history for the sake of a button
   (§109).
5. **The API must read its own integrity rules, not rediscover them.** V2's partial unique index — one live hold
   per `(slot_id, user_id)` — is the actual rule, but `existing()` keyed on `party_size` too. Changing your party
   size therefore passed the replay guard, claimed seats, and hit the index: a 500 with a rolled-back claim. Now
   the same size replays the same code and a different size answers 409 `reservation_exists` naming the code to
   cancel. `ReservationApiTest` pins both halves.

Also recorded: `reason` has no column on `reservations`, so a cancellation reason is written to
`audit_logs.metadata` and the response says where it went rather than pretending it reached the merchant — and
says plainly that **no route notifies the merchant**, because a person who has spoken to a restaurant needs to
know the app did not pass the message on.

Deliberately not done: no `GET /api/v1/reservations/{id}` (§6 does not list it, and `/api/v1/me/reservations`
already lists the holder's own), no `POST …/cancel` alias (that is the orders' shape, and two spellings of one
transition is how they drift apart), no migration for `cancelled_at`/`cancellation_reason`, and no test for the
merchant console — `com.nexus.merchant` now has a controller but still ships zero integration tests, so the D25
hours mirror is reachable and unverified at the same time.

## D27 `error.code` is a status ladder, not a closed vocabulary — 2026-09-23

Found by the first run of `scripts/verify_payload_conformance.mjs` against live services: the platform's 404
body carries `"code": "merchant_not_found"`, which `error_envelope.json` rejected as outside §1's eight. That
was CONTRACT NOTE 9's ruling (closed enum, subject in `details.resource`) meeting the code that §1's own
example line sanctions — and the grep says the example is the norm, not the exception: **22 resource-qualified
codes ship in `services/platform/src/main/java`** (`api_key_not_found`, `campaign_not_found`,
`cart_not_found`, `cart_item_not_found`, `conversation_not_found`, `coupon_not_found`,
`idempotency_key_conflict`, `import_job_not_found`, `member_not_found`, `merchant_not_found`,
`notification_not_found`, `offering_not_found`, `order_not_found`, `preference_not_found`,
`reservation_not_found`, `review_summary_not_found`, `seo_route_not_found`, `slot_not_found`,
`subject_not_found`, `tenant_not_found`, `user_not_found`), and `apps/web` is already built on the family:
`src/lib/data.ts` documents "a not-found code that carries its subject", and
`app/[city]/[category]/page.tsx` keeps a `NOT_ROUTABLE` set to enumerate them.

Three ways out were on the table:

1. **Make the services conform** — 8 codes, subject moved to `details.resource`. Rejected: 22 emit sites in
   modules other streams are actively editing, a matching client change, and the result is a *less*
   informative wire field for no gain — `details.resource` and the code suffix carry the same bytes.
2. **Curate a closed list of the 22** — keeps drift detectable, but in a parallel build every new resource
   needs a contract edit before its handler can be written, which is exactly the pressure that makes a
   vocabulary get ignored rather than extended. Rejected for process reasons, not technical ones.
3. **Rule §1's eight as the ladder and allow a resource prefix** — adopted.

Ruling: `error.code` is either one of §1's eight ladder codes **or** `<snake_case_resource>_<suffix>` where
the suffix is one of `not_found | conflict | forbidden` — the three codes where naming the subject changes
what the user is offered next (a 404 page, a replay prompt, a permission wall). Consequences, all enforced:

- The **status is read off the suffix**, so `ladderErrorCode("merchant_not_found") = "not_found" → 404`. A
  client that has never heard of `slot_not_found` still lands on the right rung of §105's failure ladder —
  which is the only thing §1's table is for.
- `error_http_status_matches_code` in `scripts/rules.mjs` now resolves through the suffix, so a
  `merchant_not_found` sent with 403 fails the contract. The closed-enum version could not express that
  failure at all: it rejected the code before the status was ever examined.
- `details.resource` stays mandatory for a **bare** `not_found` and is not required for a resource-qualified
  one — a code that already names the subject does not need to name it twice. That is the `if/then` branch in
  `error_envelope.json`, left deliberately on `const: "not_found"`.
- `validation_error`, `rate_limited`, `ai_unavailable`, `internal`, `unauthorized` may **not** be specialised:
  their `details` shapes (`Retry-After`, the ladder rung, the field map) are the whole payload, so a prefix
  would only hide which `if/then` branch applies.

This ruling settles exactly one line of the live report. It does not launder the rest: the same run filed 59
other violations — `organic_rank` and `score_breakdown` on consumer cards (§66/§116 ranking internals in the
render contract), `endpoint: "/ai/v1/compare"` against D5, `view`/`ask` CTAs outside `CARD_ACTION_TYPE`,
platform cards rendering a `rating` no fact backs — and each of those stays a bug with an owner in
`docs/STATUS.md`. A contract that widens itself to whatever the code does is not a contract.

## D28 Where a card citation lives: `facts[]` for values, on the object for live state — 2026-09-23

The same live run asked a smaller question in a different shape: the AI service puts `fact_id` inside
`EntityCard.rating`, the published `RatingInfo` is closed at `{value, count, smoothed?}` — and `AvailabilityInfo`
already has a `fact_id`, and `OpeningState` a `source_fact_id`. Three card objects, three spellings of "this came
from that fact row", so one of them is a bug and it is not obviously which.

Ruling: **a rendered *value* is cited by `facts[]`; a rendered *state* carries its own citation.**

- Price and rating are values with an ordinary TTL. §2 says `facts` is the "Fact[] backing every rendered number",
  and `entity_card_rendered_value_backed` enforces exactly that, so a second pointer inside the value would either
  agree with `facts[]` for no reason or — the failure that actually matters — quietly disagree with it while
  `packages/ui`'s trust badge reads the other one. `rating.fact_id` is dropped at the service.
- Availability and open/closed are **states with TTL 0** (AGENT §5). Their whole claim is "as of now", which a
  `facts[]` entry one indirection away cannot express: the object needs `as_of` and its `source_fact_id` on the same
  surface the renderer reads. That is why those two are allowed their own citation fields and price/rating are not.
- Nothing changed in the schema for this ruling, which is the point: §2's shape was already right, and the fix is
  one field off the AI's projection (`STATUS.md` row A3). If a future field genuinely needs per-value provenance that
  `facts[]` cannot carry, that is a new *rule* in `scripts/rules.mjs` and a reason to say why in `AGENT_CONTRACT` —
  not a licence for each service to name its own citation field.

Recorded because the drift is symmetrical and easy to re-introduce: adding `fact_id` to `RatingInfo` to make the AI's
payload legal would have turned one service's invention into a permanent contract ambiguity, and the closed-object
check that caught it would have been the thing deleted.


## D29 Identity uniqueness follows the tenant — 2026-09-23

`V1__init.sql` declared `users_email_uniq ON users(email)` and `UNIQUE (provider, provider_id)` on
`user_identities`. Both are global. Every read of the same tables is tenant-scoped (`where tenant_id = :tenant_id`),
and `AuthService`'s own duplicate-register message says "already registered **in this tenant**". A constraint and a
query that disagree is not a stalemate: the constraint wins, so a second tenant that registered an address the first
tenant already held got an unhandled `DuplicateKeyException` — a 500 from a public, unauthenticated route. The §87
demo login made that reachable by anyone who ever clicked it, because it inserts `demo.consumer@example.hk` *per
tenant*: the first tenant to try got a session, every tenant after it got a stack trace. Two tenants could not both
serve a customer named Alice, which is not a limitation of the schema so much as the end of the tenancy model in §2.

Ruling: **an identity is unique inside a tenant, and the database is the thing that says so.**

- `user_identities` gains `tenant_id` (backfilled from its own `users` row, then `SET NOT NULL`) and the key becomes
  `(tenant_id, provider, provider_id)`; the email index becomes `(tenant_id, email)` with V1's predicate kept
  verbatim, so a soft-deleted account still cannot hold an address hostage and pure-OAuth accounts with no email
  still never collide. That is `V4__tenant_scoped_identity.sql`.
- Carrying `tenant_id` on the identity row is duplication in the schema-relations sense and correctness in the
  security sense: the alternative was to keep joining `users` to find out which tenant an identity belongs to, i.e.
  to let a future query decide tenancy by whether it happened to include the join. `locations` and `offerings`
  already duplicate the column for the same reason.
- Nothing in the request shapes changed, so the HTTP contract needed no new field. What did change is the *meaning*
  of a 409: `email_taken` now asserts "taken in this tenant", and a client that reads it as global would be
  confirming to a caller that some other storefront has the address — which §2 forbids as surely as a leak.
- Register's pre-check is a read, and a read is not a constraint. The insert is wrapped so that a concurrent
  duplicate answers the same 409 either path takes, instead of the 500 the race used to produce.

`AuthTokenTest.emailIsScopedToItsTenant` is the guard: the same address registers twice in two tenants, gets two
different ids, each logs into its own account, and the duplicate inside one tenant still 409s. This settles
uniqueness for `users` and `user_identities` only. It does not license a global lookup anywhere else, and it does
not decide whether a *platform* admin should ever be able to find a person across tenants — that route does not
exist yet and would need its own ruling.

## D30 The credential that migrates is not the credential that serves — 2026-09-23

V4 was the first migration that had to change a table, and the platform could not boot with it pending:

```
Script V4__tenant_scoped_identity.sql failed
SQL State  : 42501
Message    : ERROR: must be owner of table user_identities
```

The reason was in two config files that agreed with each other and with nothing else.
`infra/postgres/init/00_roles.sql` gives `nexus_app` `USAGE, CREATE` on the schema — enough to make a new object,
not enough to alter one it does not own, since every table in the database belongs to the infra superuser.
`infra/docker-compose.yml` then set `SPRING_FLYWAY_USER: nexus_app`, and the host dev path inherited the same
assumption (`00_roles.sql` even carried the comment "app role also runs Flyway in dev"). V1/V2 never exercised it
because the script applied them as the superuser; V3 passed only because `db_apply_migrations.sh` deliberately hands
*view* ownership to the app role, which is a narrow exception for the one object type a migration has to replace in
place. So "the service migrates itself at boot" had been true for exactly one kind of DDL, and it was never written
down as a limitation.

Ruling: **the migration credential and the runtime credential are different, in every environment, and neither one
is a secret in a tracked file.**

- `application-dev.yml` now sets `spring.flyway.url/user/password` from `NEXUS_MIGRATION_DB_*`, defaulting to
  `postgres` + `NEXUS_DB_ROOT_PASSWORD` (which lives in the gitignored `.env` — §131). The runtime datasource still
  connects as `nexus_app`. `infra/docker-compose.yml` carries the same split explicitly.
- `scripts/run_platform_dev.sh` names the active profile out loud. It did not before: `SPRING_PROFILES_ACTIVE` was
  set only by compose, so a host launch ran on the base defaults while everyone believed `application-dev.yml` was
  in play — which also means the dev profile's port pins and its generous rate-limit windows had never actually
  applied locally until this change.
- Ordering matters more than the choice. `nexus_app` must not gain DDL rights, because the §9 role split is the
  structural guarantee behind "no `LLM → database`" (§52); a role that can `ALTER TABLE orders` is a role whose
  mistakes are not caught by the database.

Two things this does **not** fix, recorded rather than smoothed over:

1. Revoking `nexus_app`'s leftover `CREATE` needs a migration, not an edit to `00_roles.sql` — that file only runs on
   a first-boot volume, so editing it would fork fresh databases away from the dev one that already exists, which is
   the failure mode D22 exists to prevent. The grant stays, and is now commented as a leftover where it is set.
2. Flyway and `db_apply_migrations.sh` keep *separate* ledgers (`flyway_schema_history` vs `schema_migrations`).
   Applying V4 with `--file` leaves Flyway unaware of it, and the test database runs with `spring.flyway.enabled=false`,
   so a hand-applied migration there is validated by nothing at all. Editing an already-applied migration also
   changes its recorded Flyway checksum: V4's header was renumbered from D28 to D29 after it had been applied, and
   the boot refused it until the history row was dropped and the resumable file re-run.

## D31 A workspace grant's subject is the person, not the membership row — 2026-09-23

`permission_grants.subject_type` accepts `(user, merchant_user, agent, api_key)`, and the obvious reading of
`merchant_user` is "the id of a row in `merchant_users`". The seeder wrote it that way. Nothing in the runtime agrees:
`AuthorizationInterceptor` tests three spellings of one check, and every one of them passes
`principal.subjectId()` or `principal.userId()` — both ids on `users` — with `merchant_id` carrying the workspace.
A grant keyed to the membership row is therefore invisible to the only code that reads grants, which is how the
seeded demo console ended up with 15 grants, 3 owners, and a 403 on every workspace route (§48's vocabulary,
unreachable in practice).

Ruling: **`subject_id` names the acting subject. For a workspace grant that subject is a person, and the membership
is a separate fact that must also hold.**

- The seed now writes `(subject_type='merchant_user', subject_id=<users.id>, merchant_id=<the workspace>)`, which is
  what the interceptor honours. `data/seed/quality.sql` checks the property from both sides: a
  `merchant_user` grant must reach an *active* membership at the same merchant, and every seeded
  owner/manager membership must have grants. Its FK probe joins the same way the interceptor does, so the check
  can no longer pass on a shape the service cannot read.
- Two things follow that the old reading gave for free and this one does not. Removing somebody's membership does
  **not** revoke their grants — the rows still name a person who is no longer in the workspace — so revocation has
  to delete grant rows too, and nothing in the schema enforces that pairing today. And `agent`/`api_key` subjects
  stay keyed by their own table's id, because for those the acting subject *is* the credential, so no membership
  is involved.
- The alternative was to make the runtime resolve the membership row and check grants against it, which is the
  cleaner model (a grant then belongs to a role-holder-in-a-workspace and dies with the membership). It is also a
  change to every permission call site, the `Principal` shape, and the RBAC tests, in a module another stream owns.
  This ruling records the seam; it does not pretend the current shape is the destination.

## D32 The runtime role gets no schema `CREATE`, and a ledger-less database says so instead of being clobbered — 2026-09-23

D30 split the migration credential from the runtime credential and left one item open on purpose: `nexus_app`
still held `CREATE` on `schema public`, granted back when that role also ran Flyway. The reasoning recorded there
— "this file only runs on a first-boot volume" — was wrong. `00_roles.sql` is re-run at the end of
`scripts/db_apply_migrations.sh` (its own header says so, and the run below proves it), so narrowing the grant in
the file that makes it reaches the existing dev database too, with no fork between fresh and existing volumes.

Ruling: **the platform role holds `USAGE` on the schema and DML on its tables, and nothing that creates a database
object.**

- Granted as `GRANT USAGE ON SCHEMA public TO nexus_app; REVOKE CREATE ON SCHEMA public FROM nexus_app;` — the
  `REVOKE` is written out so re-running the file stays idempotent. `nexus_ai` was already `USAGE`-only, so the two
  roles now agree on the rule the §0 privilege split intends.
- What the privilege actually bought: nothing. Schema `CREATE` permits *new* objects, not changes to objects the
  role does not own — which is exactly why V4 failed as `42501 must be owner of table user_identities` *while* the
  app role held it. Verified from both directions afterwards: `nexus_app` cannot create a table
  (`permission denied for schema public`), and 94 integration tests plus the live booking walk run as `nexus_app`
  against a `U`-only schema with no change in behaviour.
- `ALTER DEFAULT PRIVILEGES FOR ROLE <db-owner> ... TO nexus_app` (already in the file) is what makes the revoke
  safe for future migrations: a table V5 creates gets DML for the runtime role automatically, so no migration ever
  needs the runtime role to be able to create anything itself.

The same run exposed the second half. `nexus_test` has every object V1–V4 creates — its index and constraint sets
match the migrated dev database one for one, 334 of 334, the three deltas all being Flyway's own bookkeeping
tables — but records **zero** rows in `schema_migrations` and has no `flyway_schema_history` at all
(`spring.flyway.enabled=false` in `NexusIntegrationTest`, so the service never migrates it). Against that database
`db_apply_migrations.sh` tried to re-run V1 and died on `relation "tenants" already exists`, which also skipped the
role grants further down: a ledger that disagrees with its content blocks the whole script.

Ruling: **a migration is never silently re-applied, and the repair is an explicit declaration rather than a guess.**

- `apply_file` now separates the two failure classes. An `already exists` error stops with a message naming the
  condition (content predates ledger, hand-built schema, or half-applied) and the command that fixes the first of
  them; any other SQL error propagates unchanged, still inside `--single-transaction`, so a genuinely broken
  migration leaves no partial schema.
- `--record V<n>__<name>` inserts the ledger row and executes nothing, printing that it did so. Auto-detecting
  "content already matches" was rejected: comparing an arbitrary migration against live objects is either too weak
  to trust (a subset check passes on a half-built schema) or too specific to keep up with the files, and a wrong
  row would make a later real migration skippable. The operator asserts the match; here that assertion is the
  334-row index/constraint diff above, and `--force` remains the escape hatch when content and file must be
  reconciled by re-running.

## D33 A generated file's name is part of its contract, and the seed gate now runs on an empty database — 2026-09-23

`data/seed/generate.py` documents its output as `out/NN_<table>.sql`, `data/seed/load.sh` checks for
`out/21_collections.sql` before loading, and the CSVs it writes are `21_collections.csv`. The SQL writer was
`out_dir / f"{prefix}_{table}.sql"` where `prefix` is already `21_collections` — so every SQL file carried the
table name twice, and `load.sh` rejected a correctly generated directory with
`data/seed/load.sh: ERROR: .../data/seed/out looks incomplete (no 21_collections.sql)`. The line came in with
`e237f6d` (the parallel build wave, not the seed work), and it is reachable precisely on the path nobody had
walked: `out/` is gitignored, so a fresh clone generates it from scratch, and the probe then finds none of the
files it expects. Any machine with an older `out/` sitting in it never sees the failure, because the probe tests
existence rather than freshness.

Ruling: **the filename is part of the producer/consumer contract; the writer follows the documented name.**

- `write_outputs` now emits `{prefix}.sql`, which is what the header, the CSV sibling, and `load.sh`'s probe all
  say.
- It also deletes the previous run's `out/*.sql` and `out/*.csv` first. `load.sh` globs `[0-9][0-9]_*.sql`, so a
  rename that leaves both spellings behind makes the loader COPY the same table twice — a duplicate-key error
  naming some table at random, with the stale file nowhere in the message. `out/` is derived state; wiping the
  files this run owns is cheaper than that diagnosis, and `out/optional/` is untouched because it is not part of
  the default load set.

The reason this is recorded as a decision rather than a commit message: the bug was only reachable through a path
nobody ran — `load.sh` against a directory generated *after* the rename — which is the same blind spot V4 exposed
(D30's seeder break) one layer up. The cure for both is the same command, so it exists now:
`scripts/db_gate_fresh.sh` creates an empty database from `template0`, applies `V*.sql` + `00_roles.sql` into it,
regenerates the dataset, loads it, runs `data/seed/quality.sql` as a hard gate, and drops the database. It refuses
to run if the target resolves to `nexus` or `nexus_test`, resolves the container by checking which candidate is
actually running (this machine hosts four Postgres instances, one of them another project's — D22), and exits
non-zero on any failed check. First green run: `RESULT: PASS — 153 quality checks passed against a from-scratch
schema (tables=57, migrations=4)`, with the two defects above found on the way there; reproduced on a second run
in 63s, exit 0, neither live database opened.

Not done: it is not wired into `make`, because `Makefile` carries another stream's uncommitted edits — the script
stands on its own and the target can be added by whoever next owns that file.

## D34 A guide is a row in `collections`, its items are the flat array the column holds, and blocks are passed through — 2026-09-23

§8 built the read path. The first thing it surfaced is that the contract and the storage describe two different
columns: §8 documented `Guide.body_blocks` as "`collections.items` jsonb — an ordered array of
`{type: paragraph|heading|list|cards}` blocks", while V1's own comment on that column says
`ordered [{subject_type,subject_id,note}]`, DATABASE.md §3.9 repeats "ordered `items jsonb`", and all four seeded
rows (the Sha Tin date guide, two collections and one itinerary) are flat. Both documents were current. Writing
the controller forced the question, because a block-only reader renders **zero cards for every guide in the demo**.

Ruling: **`collections.items` is the flat ordered array; typed blocks are tolerated and passed through, never
invented by the platform.** §8 now states it that way.

- Resolution is a read-side concern. Merchant references are resolved through `MerchantCards` — one batched
  `cardsByIds` for the whole row, never a query per item — and the response carries `items` (stored order, each
  resolved entry nesting its own `card`), `cards` (the same walk flattened) and `dropped_item_ids`.
- An id that resolves to no published merchant **drops the item and is named**. Placeholder cards are the §19
  failure §8 was already guarding; a silently shorter list is the same failure one layer down, so the drop is
  reported rather than hidden. `item_count` stays the stored size, which is what lets a page say "10 cited,
  8 still open".
- `cards` follows the items, repeats included. The seeded guide cites ten items across nine shops, and a
  distinct-shops array would be one shorter than the list it came from — which reads as a lost row. Measured on
  the running service: `item_count 10 · items 10 · cards 10 · distinct 9 · dropped 0`.
- An element carrying `type` (a paragraph, a heading) is echoed unresolved. "This read cannot project it" is not
  "it does not exist", and deleting a guide's prose because it is not a merchant id is the worse of the two
  errors. No migration adds block storage: nothing writes blocks today, no consumer reads them, and a column
  invented for a shape the seeder does not produce is how the next D33-class divergence gets written.
- Attribution is derived exactly as §8 words it, and the platform applies the §27 gate rather than delegating it:
  `generated_by` falls back to `creator` only when `author_id` is a real account, `curated_by.name` is that
  account's `display_name`, a `model` curation with no model named reports as `ai` / `"AI curation"`, and
  `noindex` + `noindex_reason` are computed here. Live, the seeded guide answers
  `creator · 陳小姐 (Demo) · noindex true · not reviewed by a human (§27)` — the name is the account the seeder
  created, not a persona.
- The publishability predicate lives in the repository's `WHERE`, not in the controller, so the list and the
  by-slug 404 cannot disagree about what is readable. An unattributable row is absent from both.

`POST /api/v1/collections` stays unbuilt on purpose. It is the one §8 write that creates a publishable consumer
page, so it belongs behind the workspace permission chain with the §27 authorization recorded on the row, not
beside four anonymous cacheable reads.

## D35 One rounding convention, and the rating behind every rendered rating — 2026-09-23

§19 says a number a consumer can see must carry the fact behind it. The card renders
「4.3 · 128 則評價」from `merchants.rating_agg` + `review_count`, and `MerchantCards` has joined a lateral for a
`rating` fact since D25 — but the seeder emitted **no `rating` rows at all**, so the join was always null and the
array carried price and hours only. Measured over the seeded tenant: 520 merchants render a rating, `select
attribute, count(*) from facts group by 1` returns `address, capacity, cuisine, opening_hours, price` and no
`rating`.

Finding the absence turned up a second defect. Comparing the stored aggregate against a SQL recompute over the
same reviews — `having m.rating_agg <> round(avg(r.rating), 2)` — named **seventeen merchants, every one of them
exactly 0.01 apart, every exact mean ending in `.xx50`**. Not corrupt data: two rounding conventions. Python's
`round()` is half-to-even (2.825 → 2.82), Postgres' `round(numeric, 2)` is half-away-from-zero (2.825 → 2.83), and
the seeder's own invariant check tolerated it (`abs(stored - want) > 0.01`), so the generator reported PASS on a
dataset where the API and any re-derivation disagree with each other.

Ruling: **the seeder rounds the way `numeric` rounds, and the checks compare exactly.**

- `round2` / `mean2` in `data/seed/generate.py` do the arithmetic in `Decimal` — half-up, and no float summation
  error — so the stored value and `round(avg(rating), 2)` are the same number by construction. `m2`, which writes
  every money field, uses the same helper for the same reason: `merchants.avg_price_hkd` goes through Postgres'
  rounding whether Python agrees with it or not.
- The `> 0.01` tolerance is gone from the self-check. A tolerance on an equality the database can recompute is not
  a check; it is a place for a defect to sit.
- A `rating` fact now exists for **every reviewed subject** — 520 merchants and the offerings reviewed individually
  — with `source='observed'` (the platform's own arithmetic over its own review rows, not a merchant's claim),
  `confidence` banded by sample size (`n<5 → 0.70`, `n<50 → 0.80`, else `0.90`), a 24h TTL matching
  `review_summary`'s, and a value that restates the aggregate *and* says what the column cannot: `count`,
  `max_score`, `method`, and `reviewed_through`, the newest published review inside the window.
- Confidence is about the sample, never the arithmetic. A mean of four opinions is computed exactly as reliably as
  a mean of four hundred; it just supports a weaker claim, and `CONFIDENCE_FLOOR_PHRASE` (AGENT_CONTRACT §4) is the
  AI layer's threshold for hedging — a flat 0.90 would let one five-star review be quoted without qualification.
  Every band sits at or above that floor, because a review mean really is first-party data.
- `observed_at` is the recompute instant, not the newest review's. The alternative puts every rating fact outside
  its own TTL the moment it is written — the reviews are months old — which reports a fresh calculation as a stale
  claim. The evidence window is stated where it belongs, inside the value.
- Zero reviews ⇒ no fact and no rating, which `MerchantCards.rating` already enforced. An unreviewed subject that
  acquired a rating fact would be the §109 failure in a new costume, so `quality.sql` forbids it in that direction
  too.

Six checks went into `quality.sql` alongside the existing TTL checks: one fact per reviewed subject (and no fact
without a reviewed subject), agreement with the recomputed mean, agreement with the rendered column, an evidence
window that is not in the future relative to its own inputs, a confidence that tracks `n`, and the 24h TTL with
`source='observed'`. Fresh-database gate: **159 checks** (was 153), `facts` 4,661 → 5,688 rows, `RESULT: PASS`,
exit 0, neither live database opened.

The §8 read got the same treatment for a shape it used to discard: an element of `collections.items` that is not
an object — a bare id string from an older seed, a number, a null — is now echoed in `items` instead of vanishing,
so `item_count 4 · items [] · dropped_item_ids []` is no longer an answer this endpoint can give.

## D36 `facts.source` is a closed vocabulary, and an estimate is not a provenance — 2026-09-23

`facts` has no CHECK on `source`. The vocabulary lives in two other places — API_CONTRACT §2 /
AGENT_CONTRACT §4 (`merchant|imported|observed|third_party|inferred|demo`, and §4 ranks exactly those
strings for conflict resolution) and `packages/types` (`FactSource`, which the published `fact.json` schema
enumerates) — while the column is free `text`. Nothing in the database, the service or the suite joined
those two sides, so the seeder was free to write whatever it liked.

It did. `select distinct source from facts` on the seeded tenant: `demo, estimated, merchant, observed`.
171 rows said **`estimated`**, which is not a provenance — it is how a number was obtained. The value came
from `offerings.price_source` (whose own documented domain *does* include `estimated`, and whose
`flags.estimated_price` consumer reads it), copied straight into the fact's `source` column.

Why that matters more than a typo:

- The published `Fact` schema rejects it. `fact.json` lists six sources and marks the field required, so
  any payload carrying such a fact is invalid against the project's own contract.
- Source is the tie-breaker for conflicting claims (§4: merchant > observed > imported > third_party >
  inferred > demo). A seventh value has no rank, so the resolution of "merchant said 80, something said
  80" depends on which string sorts later rather than on who vouched for it.
- It overstates. "Estimated by the platform" and "a merchant told us" are different claims, and the first
  one is what an estimate is.

Ruling: **the estimate stays where it belongs and the fact says `inferred`.**
`offerings.price_source` keeps `estimated` — that column's vocabulary is its own and something reads it.
The fact that carries the same number gets `source='inferred'` (documented, ranked last but one, and true:
the platform worked it out), and `value.estimated = true` so the estimate is still visible *inside* the
citation rather than smuggled into the provenance field. `PRICE_SOURCE_TO_FACT` is the one mapping, and
`quality.sql` now refuses any source outside the six, so the next coinage has to be a decision.

Three structural checks came with it, because none of them was enforced anywhere: no second row for the
same `(subject_type, subject_id, attribute)` (the reader takes `order by observed_at desc limit 1`, so a
duplicate is two competing truths and a coin toss), `confidence` inside 0..1 (`numeric(4,3` allows 9.999),
`expires_at > observed_at`, and `stale` only where the TTL has actually run out.

Gate: **163 checks** (was 159), `RESULT: PASS` on a from-scratch database, exit 0.

The walk learned the same lesson from the other side. `verify_reservation.py` compared the slot's price
with the reservation's and the reservation's with the merchant inbox's — and both passed on `null == null`,
because the directory's popularity-sorted first page is all restaurants and their table slots are
unpriced. 8,513 of 32,492 seeded slots do carry a price; the walk now looks for one, and reports
`slot=473.11 reservation=473.11` instead of agreeing about nothing.

## D37 A consumer review is queued, counted nowhere until published, and badged only by evidence — 2026-09-23

§6 promised `POST /api/v1/merchants/{id}/reviews` for the whole life of this project and nothing served it:
a consumer could read 11,000 reviews and add none. Building the write forced three decisions that a
"insert the row and return 201" implementation makes silently.

**1. `status='pending'`, and an `open` row in `moderation_cases` beside it.** §55/§127 put user-generated
content in front of a stranger only past a human decision, and this build has no automated abuse filter —
`fraud_trust` is a designed agent, not a running one. Writing `published` (the column's own default) would
have made the public rating whoever-typed-fastest's. The pending row is echoed to its author and to nobody
else; the public `/reviews` read already filters on `status = 'published'`, so no other code had to change
to keep it out. A pending review with no case in the queue is a review nobody will ever read, which is why
one insert is not enough.

**2. It moves no rendered number, and the response says so.** `merchants.rating_agg` and the `rating` fact
beside it are defined over published rows (D35), so a queued review cannot change the average — and
`aggregate_changed: false` travels in the payload rather than being something the reader has to infer. This
is the invariant that makes decision 1 safe instead of merely quiet: publication is the moment both must be
restated, and there is deliberately no route here that performs it.

**3. The visit badges are looked up, never accepted.** The body's own `verified_reservation`/
`verified_purchase`/`data_origin` fields are ignored; the flags come from this caller's reservation and order
rows at this merchant (`confirmed|completed` and `paid|preparing|completed`), and the response prints the
predicate it used under `verification_basis`, so a tick cannot mean more than the row behind it. `data_origin`
is the literal `'user'` — the one honest origin for this write, and the flag that keeps it out of the demo
badge.

Two refusals carry the same reasoning. A missing `Idempotency-Key` is 422 (a double-tapped submit must not
create two reviews and two cases). A second open review from the same account at the same place is
409 `review_exists` — one voice per person per place, inside an aggregate that claims to count people —
unless the first was `rejected`, which is a judgement about that text and not a permanent silence.

**The exception that had to be made, and why it is not a hole.** The first live run of the route returned 409
for the demo consumer at the first merchant it tried, everywhere: the synthetic corpus attributes thousands
of published reviews to the very accounts a session can log in as. Counting those against the one-voice rule
would leave no demo user able to post at all — an honest route nobody can reach is still a dead route. So
`openReviewBy` excludes `data_origin = 'demo'` rows: a synthetic review is not anybody's voice. The synthetic
rows keep their place in the aggregate (that is what a demo dataset is, and they are badged `demo` while
they do it); what they cannot do is spend a real person's one review. `demoRowsDoNotBlockARealReview` pins
both halves.

Suite: 115/115 (7 new in `ReviewWriteTest`). Over HTTP against a throwaway seeded database, posting to
`basil-leaf-0419`: `201 · status=pending · data_origin=user · verified_*=false ·
aggregate_changed=false`, the page's rating `3.79 · 291` identical before and after, and in the database
one `user` review and one open case.

## D38 A claim is one row, and it can be restated — 2026-09-23

Found while making D37's review queue publishable. Restating a rating fact means updating its row, and
`update facts set …` fails:

```
ERROR:  record "new" has no field "updated_at"
  in PL/pgSQL function set_updated_at() line 2 at assignment
```

V1 walks a list of tables and puts `<table>_updated_at BEFORE UPDATE → set_updated_at()` on each, `facts`
included — but V1's own `facts` declaration has `created_at` and no `updated_at`. The trigger body is not
validated until it fires, so the schema ships believing facts are updatable and the first attempt anywhere
discovers they never were. Not "were designed insert-only": **no UPDATE of a `facts` row has ever succeeded
in any environment of this project**, and `FactRepository.record` is an INSERT because an upsert threw.

That accident was load-bearing in a bad way. DATABASE.md §7, AGENT_CONTRACT §5 and D25 describe `facts` as
the row a rendered claim cites and require a merchant edit to *restate* it; D36 made one row per
`(subject, attribute)` a checked invariant; D37 leaves reviews to be published, which moves an aggregate and
so must restate a rating fact. All three describe a table the schema forbade.

Ruling:

- **V6 adds the missing column** (`updated_at timestamptz NOT NULL DEFAULT now()`), which is what the trigger
  V1 already installed expects, and what every other table on that list already had. `updated_at` is when the
  row was last restated; `observed_at` is when the value was true of the world; `expires_at` is its deadline.
  Three different clocks, and only the first two were in the table.
- **V5 makes one claim one row.** Dedupe by keeping the newest observation per `(subject_type, subject_id,
  attribute)`, then a unique index. Without it, the readers' `order by observed_at desc limit 1` is a coin
  toss between two live claims and D36's seeded-only check is a promise about data the platform never wrote.
- **`FactRepository.record` upserts.** A re-observation replaces the value, source, confidence, TTL and
  freshness of the same row, so a refreshed claim is fresh again rather than a second expiry clock running
  beside the first. `returning id` gives the caller the surviving row either way.
- **The merchant price fact is `price`, not `avg_price`.** `MerchantService.recordProfileFacts` filed the
  edit under `avg_price` while `MerchantCards`, the seeded corpus, `quality.sql` and `FactAttribute` all join
  `price`. So the write landed in an attribute nobody reads and the card went on citing the pre-edit number
  as its provenance — a citation that had become false, which is the one thing a trust row must not be.
  `avg_price` rows in any database: 0 written after this, 0 read by anything, ever.

Tests (`FactWriteTest`, 2 new; suite 117/117): edit → the card's price fact says 88.00, edit again → 120.00
and still exactly one row; and the second observation is the *same row id*, with `stale=false` and
`expires_at - observed_at` still exactly six hours, measured from the new observation rather than inherited.
Both are the assertions that would have failed loudly before V6 and could not be written at all before it.

Gate: V1..V6 from an empty database, `RESULT: PASS — 163 quality checks (tables=57, migrations=6)`.

## D39 A consumer review ends at a human door, and the door is not the merchant's — 2026-09-23

D37 stored a consumer review as `pending` and D38 made a fact restatable. Neither had a way to finish, so
"a human decides" was an honest answer with no route a human could take, while API_CONTRACT §9 documented
`GET /api/v1/admin/moderation` and `POST /api/v1/admin/moderation/{case_id}/resolve` and nothing served them.

**The door is a platform surface, deliberately.** Both routes take `@RequiresPlatformRole`
(`platform_admin`/`platform_ops`) and neither takes a merchant scope. Routing a merchant's own review
decision through `permission_grants` would be reachable by `admin_members`, which means a business could
publish the five-star review of itself and reject the one-star — which is precisely the thing §109 forbids
the rating from becoming. So the reviewer is a platform operator, and the queue is one list across tenants.

**What a read must show.** A case carries its subject's projection (the same one the public page uses, D24)
plus `merchant.status`, because publishing content for a shop nobody can open is a different decision from
publishing it, and it should look different in the queue.

**What a decision must be.** `decision ∈ published|rejected|flagged` — the three states a review row can
hold, not the friendlier-sounding `approve`, which is refused with a 422 naming the allowed set. An optional
`note` up to 500 characters is stored on the case. The case close is guarded on `status = 'open'` in its own
statement, so two reviewers who both click get one winner and a 409 `case_already_resolved` for the other —
the loser's decision is not quietly written over the winner's. Publishing restates the merchant's rating and
its fact, and the offering's too when the review cites a dish (D35/D38); rejecting changes no number, and the
response says which of the two happened in `aggregate_restated`. Every decision writes an `audit_logs` row
with before and after.

_(Recorded 2026-09-23 by D40's commit: the D39 commit itself wrote this decision only into its own message,
which is why this file had a `### Follow-up` about D39 and no D39 to follow. A ledger that cannot answer
"what is D39?" by number is not a ledger.)_

### Follow-up: the queue, the transaction, and a verifier that blamed the wrong thing

D39's door needed three more things before it could be trusted with the demo dataset, and the middle one is
a lesson about reading a failure.

**The seed had no queue.** 544 reviews are stored `pending`/`flagged` and `moderation_cases` was empty, so
the endpoint answered `[]` — and `quality.sql` said nothing, because it had never had a reason to look. The
seeder now opens one open case per non-terminal review (`none` for a first publication, `flag` for an
auto-caught one), and three checks bind the pair in both directions: every waiting review has exactly one
open case, no case points at a review consumers can already read, and — the part that makes an empty inbox
visible — the queue is non-empty. 163 checks became **166**.

**A decision is one transaction.** The resolve path writes four things (review status, case closure,
merchant aggregate + fact, offering aggregate + fact) and they were four statements. Moving them into
`ModerationService` under `@Transactional` is right on its own terms — a reader must not see a review
published against a citation that still describes the previous set — and it is also how I *thought* I had
explained the intermittent failures below. It had nothing to do with them.

**The verifier was wrong, twice.** Running the lifecycle walk against fresh databases failed 2 times in 6,
always at "the published review is counted, printed and cited identically". The transaction looked like the
cause; it wasn't. The evidence, once the walk printed the slug and the HTTP status, was
`bramble-foundry-0108: no rating fact beside the printed rating {}` — and `{}` was an **error envelope**:
the profile had answered 404. That merchant is `pending_review`, so publishing its review is a correct
decision about a page no consumer can open. Two separate fixes fell out of it, neither of them the
transaction: the queue now carries each case's `merchant.status` (a reviewer should see they are approving
content for an invisible shop), and the walk distinguishes "no citation" from "no page", picking a readable
case and asserting the unreadable kind really is 404. The scan of all 470 published cards found **zero**
card/fact disagreements, which is what proved the data was never the problem.

A verifier that reports a missing page as a missing citation is the same failure this whole line of work
keeps finding, one layer up: a green or red signal computed from the wrong evidence. Four walks on a
pristine queue after the fix: **15/15 each**, and the suite is **121/121** with the new
`subject.merchant.status` assertion.

## D40 A membership row is a record; the grants are the access — 2026-09-23

API_CONTRACT §5 documented `GET/POST/PATCH/DELETE /api/v1/merchant/members`,
`POST/DELETE /api/v1/merchant/api-keys` and `POST /api/v1/merchant/ai-agent/config`. None of them was
served — by tracked code or by any of the in-flight waves' untracked files — even though every part needed to
serve them already existed: `MerchantRepository` had `members/addMember/updateMember/removeMember`,
`ApiKeyService` had `create/list/revoke`, and `WorkspaceAccess` had `member:` and `apikey:` merchant
resolvers waiting for a route to declare them. What §5 lacked was not machinery but doors.

**Amended by D44 (2026-09-24), before the sentence below.** D5 is "Auth & tenancy": JWT, the tenant predicate,
and 404-instead-of-403. It never mentions `permission_grants`. So the attribution in the next line is wrong — the
rule is this decision's own — and the interesting part is how far a wrong citation travelled: five comments in
three packages had copied it from here, and D44 corrected all five to say D40.

**The rule the doors have to honour is D5.** `permission_grants` is what authorises; `merchant_users.role`
is a convenience for choosing a set of grant rows. That has a consequence nobody had written down: *assigning
a role is a write to `permission_grants`*, and so is taking one away. A screen that shows "removed" while
the removed person's grant rows are still answering authorisation checks is not a slightly stale screen, it is
a lie about who can read the orders and issue the keys. The schema will not catch this — `permission_grants`
has no foreign key to `merchant_users`, and `subject_id` is a bare uuid — so these methods do it
themselves, in one transaction with the row:

- a role assignment writes that role's default set (under `subject_type='user'`, the spelling the owner path
  uses, D31);
- a role change adds what the new role has and deletes what it does not;
- `status = 'disabled'` deletes every grant and keeps the membership row, so the audit trail survives and the
  access does not;
- removal deletes the rows under **both** spellings a human's grant can be filed under (`user`,
  `merchant_user`), because the interceptor accepts either, and revoking only one would leave the other
  working;
- the roster reads the **union** over both spellings, so a person's listed permissions are what they can
  actually do, not what one of two possible filing choices happens to say.

**Two refusals that are easier than the truth.** The last active `owner`/`admin` of a business cannot be
demoted, disabled or deleted (`409 last_admin`): a workspace whose only administrator is removed has no
door left that the platform's own RBAC can open, and unblocking it would mean writing grant rows by hand.
`admin` counts alongside `owner` because both receive `admin_members` by default — checking only the word
`owner` would strand a business whose single `admin` steps down. And an unknown `role` or `scope` is a
422 that names the allowed set rather than being coerced: `"superuser"` is not a role this platform can
honour, and pretending otherwise would write a membership row whose grants are the staff defaults.

**Two real defects fell out of wiring routes to code that had never been reached.**

1. `PermissionService.grant()` had a guard rail that asked whether the **subject** already held
   `admin_members` — asking the person being granted to authorise their own granting. Its only caller had
   ever been the self-seed at business creation (`grantedBy == subjectId`), so no first real second-person
   grant had happened to reveal that every one of them would have been refused with 403. It now checks the
   **operator**, under either spelling, and still allows the self-seed path.
2. `MerchantRepository.updateMember()` was an `UPDATE merchant_users mu ... FROM merchants m` with
   unqualified `status` in its own `coalesce` — and `merchants` has a `status` column too, so Postgres
   answered `ambiguous column`. The method had never been called: the 500 was its first call ever, raised by
   the first test that reached it. A statement that has never run is not "unused but working"; it is untested.

**API keys: the secret is shown once, on purpose.** `ApiKeyService` stored only a SHA-256 and had `list()`
that no route called. `GET /api-keys` is now documented in §5 (it was missing from the row that names the
method paths, though a console that cannot see its keys cannot pick the right one to revoke), and its
projection carries `prefix` and `scopes` and no secret field at all. Revocation sets `revoked_at` and
deletes the `api_key` grant rows, so "revoked" and "inert" are the same event.

**The AI switch refuses to grow a schema.** `merchants.ai_agent_enabled` is the only AI setting V1 has, so
`POST /ai-agent/config` takes `{merchant_id, enabled}` and writes that column, and its `scope_note` says
that is all there is — rather than accepting `persona` or `model` fields into a `Map` that goes nowhere.
`enabled` must be a JSON boolean; `"yes"` is a 422, not a truthy string.

**What the tests insist on.** `MerchantWorkspaceTest` (10) asserts on the grant rows in SQL, not on the
write's own 200, and checks a role change through an *unrelated* route: `GET /api/v1/merchant/customers`
(`read_analytics`, `com.nexus.growth`) is 403 for a staff member, 200 after the PATCH to `manager`, and
403 again after `disabled`. A grant reconciliation that returned 200 and wrote nothing would fail that
sequence. Removal is asserted as "0 grant rows left, and the ex-member's own call is refused". The last-admin
guard is asserted in all three directions and then *released* by adding a second admin, so it cannot be
passing because the guard is unconditional. `idempotency_keys` is keyed by a literal string and is not
cleaned between tests, so every key in this class carries a per-instance nonce — a fixed key would make the
replay assertion a coin toss against an earlier run's owner, which is exactly how two of these tests failed
before they were fixed.

Suite: **131** tests of this wave's own code pass (121 + 10). `mvn -o test` across the whole working tree
reports **138 run, 1 failure**, and that one is `com.nexus.admin.AdminConsoleApiTest` — controller, test and
package all untracked, another wave's in-flight Admin Console, deterministic when run on its own, untouched
by anything here.

## D41 When the gate and the artifact disagree, the gate is fixed first — and the fix must be provably one-way — 2026-09-23

`verify_contract_runtime.mjs` reconciles `docs/API_CONTRACT.md` against the OpenAPI document a running
platform publishes. Three rounds in a row it found, in some mix: routes the document promised in a notation
the reader could not parse, routes the reader parsed into paths the document never wrote, and routes the
service serves with no row anywhere. Each round posed the same question, and §35 deliberately left it open
rather than let it be answered by whoever happened to be fixing something else: **who moves — the gate or the
artifact?**

It cannot stay open, because "the gate is wrong" is also the most convenient sentence available to anyone a
gate catches. So the rule, written down before the next holder of a red gate has to invent one:

**1. Fix the reader only when the fix can move the verdict in one direction.** Teaching the reader a notation
may only ever add a documented path that the build then has to answer, or retire a documented path the
document does not in fact contain. It may never let one route satisfy another route's promise. This is a
check with teeth, not a sentiment, and it is how each of the four notations admitted this round was judged:
`/api/v1/me/favorites` gained a POST and a DELETE the build then had to answer for — and does, which is why
they appear in neither list now; `/.well-known/ucp` came *into* scope,
which added an obligation and removed nothing from the failing bucket; §9's
`{users|merchants|orders|reservations|reviews|reports}` went from one collapsed entry to six that each have
to answer on their own. §35's bracket expansion passed the same test only after confirming the two bracketed
rows in the whole document are §3 and §5, so no phase-1 §4/§8 read can be satisfied by "another spelling of
mine answered" — and the hard gate has never been widened.

**2. Two shorthand notations that look alike are not alike, and the gate must not average them.**
`…/offerings[/{id}]` is **one** route written with its optional suffix, so it is served when either spelling
answers. `{users|merchants}` is **six** routes written compactly, so all six are owed. Collapsing both into
"documentation shorthand" is what produced a phantom gap on `/api/v1/admin/{}` — a path no router can hold —
while quietly deleting five promises. A reader that cannot tell a hole from an enumeration is not reconciling
anything; it is guessing at a rate.

**3. Where the artifact is the wrong side, the builder of the route writes the row.** Three served routes had
no contract row at all — `GET /api/v1/reservations/{id}`, `POST /api/v1/auth/session`,
`POST /api/v1/conversations/{id}/handoff-resolve` — and all three live in tracked code, which makes them this
ledger's job rather than a message to a neighbour. They are now in §6, §3 and §7, each drafted by reading the
handler rather than the report: the reservation read answers `404` to a stranger so a booking code cannot be
probed, `/session` answers the resolved principal with no write and no audit row, and the handoff resolve
refuses (`409 no_open_handoff`) when there is nothing to close. The gate was not touched to make these three
disappear; §35's "reported, not repaired" list is closed, not extended.

**4. Say which bucket a line is in, out loud, and measure against an empty router when you are not sure.**
The report's two lists look symmetric and are not: "documented, not served" accuses the build, "served, not
documented" accuses the document, and a reader bug produces *both at once* — one innocent party per list.
Against `{paths: {}}` the extraction is the only variable in the run, so a number that moves there is a claim
about the reader and not about anybody's code. Every classification in this round was made that way first and
confirmed live second.

```
documented  121 → 133 · in scope 109 → 121 · documented-and-answered 87 → 96
documented, not served   22 → 25        served, not documented   9 → 0
```

Rule 1 earns its keep in that third line. The gap count went **up**, by three, on the run that closed the
other list to zero — because splitting §9's alternation replaced one collapsed entry with six routes, and all
six turned out to be unbuilt. The collapsed `{}` had not been reporting a gap on a real promise; it had been
hiding six false ones *and* excusing six missing handlers at once. A rule that only ever flatters the build
would have produced a shorter list here, and the shorter list would have been a lie.

The residual twenty-five are therefore safe to read as work rather than as noise, and six of the §5 entries
were checked at the source rather than assumed: no mapping exists anywhere in the tree, tracked or untracked,
for the merchant analytics, campaign, approve-publish, coupon, knowledge-base or reindex routes. That is the
payoff of the rule. A gate the build trusts has to be wrong in only one direction: it may miss a promise
nobody made, and it may not forgive one that was.

## D42 A route nobody can reach is unbuilt, and a field that prints nothing is a field that lies — 2026-09-24

D40 settled what authorises (`permission_grants`, not the role string) and D41 settled what the document owes
(every route the router declares). Neither of them looked at the third party in the arrangement: the dataset.
§5's nine workspace doors are built, unit-tested against their own fixtures and documented in the contract —
and every human in the demo was locked out of all of them. Measured on the demo database before this change:
**3** active `owner` memberships, **0** of them holding a live `admin_members`, **15** grant rows in total,
**12** of them carrying an `expires_at`. The console renders "Owner" for an account that cannot ask who else
is in the business.

**1. A permission is not held because a role is labelled, and a check for "some rows" cannot catch the wrong
rows.** The seed wrote five hand-picked permissions per owner — dashboard reads, no door — and `quality.sql`
already asked *"does every seeded owner membership have grants?"*, which five wrong answers satisfy. So the
dataset now writes the preset, and the check names what the door needs: every active `owner`/`admin`
membership must hold `admin_members` specifically, guarded by a `count(*) > 0` on memberships so an empty
dataset cannot pass by having nothing to check. `OWNER_PERMISSIONS` in `generate.py` is a copy of
`MerchantPermissions.OWNER`, because a Python generator and a Java class share no build; the copy is checked
by two readers that are not the copy — that SQL check, and `scripts/verify_workspace_flow.py`, which signs in
as the account the demo hands a visitor and calls the gated route.

**2. A printed field is a promise, and an empty placeholder breaks it more loudly than an absent one.**
`GET /api/v1/me` had answered `"permissions": []` for every membership since the route was written. A field
that is missing can be handled; a field that is present, well-formed, and false is consumed by every screen
that trusts it, and nothing in the payload said it was a placeholder. It now reads from the same method the
roster reads — `PermissionService.grantedToHuman`, which unions the two spellings a human's grants are filed
under — because a `/me` that read one spelling and a `/members` that read both would describe one person
differently through two doors, which is D35's failure mode wearing a different hat. Where the same list is
now printed twice, it is produced once: `MerchantWorkspaceService`'s private copy of the union, and its
private copy of the spelling list, are gone, so the two cannot drift.

**3. Human access is assigned, not rented.** Twelve of those fifteen rows had a deadline. A TTL on an API key
means something — a scope that ends — and a TTL on a person's role means a role that quietly vanishes on some
Tuesday, with nothing on the membership row predicting it and no reader able to tell that the "owner" in front
of them stopped being one. Human grants carry no `expires_at`, and `quality.sql` fails any that do. Deadlines
stay where they mean something: `api_key` and `agent` subjects.

**4. Reachability is proven by the account the demo hands out, over HTTP.** Ten unit tests in
`MerchantWorkspaceTest` were green the whole time the demo could not use a single one of those routes, because
each test seeded the grants it needed. A fixture that supplies its own permissions can only prove what happens
when permissions exist; it cannot prove that they do. So the new walk starts from `/api/v1/auth/demo` with
role `merchant` — the same button a visitor presses — and its 22 checks end on the claim D5 has always made
and nothing has ever observed: a key created there answers 200 on a `read_analytics` route, and the same call
answers 401 `invalid_api_key` one request after the key is revoked. Access lived in the grant rows, and that
is now a measured sentence rather than a design claim.

```
seeded grant rows              15 → 36      owners holding admin_members   0/3 → 3/3
lapsing human grants           12 → 0       quality.sql checks            166 → 168
MerchantWorkspaceTest          10 → 11      e2e workspace walk             22/22
```

The `166 → 168` is arithmetic with a witness, not a remembered number: both new checks are single-row
`INSERT INTO qc SELECT`, and the fresh gate reported 168 green after them.

What this does **not** claim to have fixed: the instance running on :8090 and the `nexus` database it reads
were built before this change and still hold the old fifteen rows, so the demo console somebody is looking at
right now is still the locked one. Reloading it means restarting a service this session does not own, and the
shared-workspace rule puts that decision with whoever runs :8090. The fresh gates — `db_gate_fresh.sh` and
`e2e_fresh.sh`, which build their own database every run — are what certify the dataset. And there is still no
merchant-console screen in a browser calling these routes, so §156's browser leg stays open with task #9.

## D43 An expiry every gate honors and nothing can set — a predicate earns its place by being able to fail — 2026-09-24

D42 removed twelve deadlines from the seed on purpose, and writing them down was the last honest thing in that
decision — because it left behind a column that no authorisation is decided by and nothing can reach.

Measuring first. `permission_grants.expires_at` appears in **four** reads: `PermissionService.hasMerchantGrant`,
`hasTenantGrant`, `grantedPermissions` (both arms) — every one carrying the same
`(g.expires_at is null or g.expires_at > now())`. It appears in **zero** of the four writers: three
`insert into permission_grants` statements in the service (`ApiKeyService.create`, and `PermissionService.grant`'s
tenant and merchant arms) and the seed's one COPY row, which passes `None` for that column since D42. And the
table a deadline would most plausibly live on cannot hold one at all — V1's `api_keys` has `last_used_at` and
`revoked_at` and no expiry column, so a merchant key does not age out, it is revoked. `AGENT_CONTRACT` §8 still
states, as a requirement, that "Grants expire (`expires_at`)". So the platform had four pieces of SQL branched
on a clock that nothing in the repository could start, and one sentence in a contract that only a test could
say whether it was true.

**1. A test for a predicate is a mutation that the test must survive.** Two single-token edits to those four
reads, run against `MerchantWorkspaceTest` (12 tests, and the class that owns this table):

```
drop the `is null` arm            → 11 of 12 red, the new expiry test among them at its first assertion
invert the comparison             → 1 of 12 red — and that one is the test this decision adds
```

The second line is the whole decision. An inverted deadline still passes every grant whose `expires_at` is null,
which is every grant the seed, the service and eleven of the twelve tests had ever produced — so the mutation
survived everything that existed a minute earlier, while answering 200 to a call that should have been refused
and refusing a key that has a day left on it. The predicate was not merely unexercised; it was unloadable.
(The rest of the suite is in the same blind spot by construction rather than by measurement: any test that
grants something with `staff()` or `own()` also hands it a null deadline.)

**2. Dating a row is the only way to tell "rejected" from "gone".** The new test asserts four states, not two:
a fresh grant opens the door, a back-dated one opens nothing *and* stops being printed by either door that
prints access, and moving the deadline to tomorrow gives the whole thing back **with no write in between**. That
last step is what separates the assertion from the neighbouring bug — a read that dropped lapsed rows and a read
that dropped all rows look identical from a 403. It is also why the fixture refuses to be silent: it updates
both human spellings, and asserts that exactly one row moved, so a grant that had never existed would fail the
test that was about to claim it lapsed. `MerchantWorkspaceTest.java:446` is now the only place in this
repository — seed, service, migration or test — that puts a non-null `expires_at` on a grant row.

**3. A comment that overreaches is a bug report nobody filed yet.** `PermissionService`'s class javadoc claimed
`permission_grants` is "the single source of truth for authorisation (D5, AGENT_CONTRACT §8) — for humans,
merchant API keys and AI agents alike." Three of those four words are load-bearing and one is not true here,
measured at HEAD: `@RequiresPermission` does read grants for `user`, `merchant_user` and `api_key` subjects;
but a platform staff member is gated by `@RequiresPlatformRole`, which compares the `role` claim the bearer
token carries through `Principal.hasPlatformRole` — a copy of `users.role` taken when the token was issued, not
a row read per request, which is the gap `POST /api/v1/auth/session` exists to close — and never reads a grant;
and the AI *service* is not a subject at all —
it reaches the platform through `AiServiceTokenGuard`'s shared `X-Internal-Token` (D12). `subject_type='agent'`
is named in V1's column comment and in §8's list, and no read in the service asks for a row filed that way; an
`ai_agent` *role* on a membership is granted as a human, which is D5's own reading of the preset table. So §8
names a vocabulary the model may grow into, not a behavior it depends on — and that distinction is the
document-owner's to make, not something to quietly implement here. The javadoc now states which doors this table
opens and which two it does not, and cites D40/D42 rather than D5, which never mentioned grants at all.

**4. This supersedes one clause of D42.** D42's rule 3 closed with "Deadlines stay where they mean something:
`api_key` and `agent` subjects." Both halves are wrong in the same direction, for the reason above: an API key
has no deadline column and `agent` has no reader. What the measurement supports is narrower and still worth
printing where an operator will read it — the `GET /api/v1/merchant/api-keys` note now says outright that
nothing but a revocation ends a key. A console that lists `revoked_at` and `last_used_at` invites the question
"when does this stop working?", and the answer is a fact about the schema rather than a policy someone chose.

```
MerchantWorkspaceTest                        11 → 12
grant rows anywhere carrying a deadline      0 → 1   (the fixture; nothing in main or seed writes one)
invert-the-comparison mutation, red tests    0/11 → 1/12
is-null-arm removal, red tests               11/12
documented surface corrected                 §3 `/api/v1/me` names `memberships[].permissions`; §5 key note says a key is revoked, not expired
```

§3's row is D41's rule about the builder of an undocumented served thing, applied one level down: D42 made
`memberships[].permissions` a field a person's access is judged by, and the contract still described `/me` as a
"profile + memberships + preferences summary" — accurate, and useless to anyone deciding whether to trust it.
The row now says where the array comes from and which other door reads the same source.

What this does **not** do: it does not add expiry. A TTL on a key would be a migration (`api_keys` has no column
to hold it), a write path, and a product decision about whether a secret should stop working on a clock nobody
set — D34's precedent is to record that gap rather than build through it, and §8's sentence is the place a
decision belongs, which §8's owner holds. It does not touch the instance on :8090 or the `nexus` database it
reads, still on D42-era rows. It leaves the merchant-console browser leg open with task #9. And
`AdminConsoleApiTest.searchAnalyticsReportsRealCounts` is still red in the untracked `com.nexus.admin` work
(`expected 2L but was 3L` at line 289) — reported, untouched, and not this session's to fix.

## D44 A citation copied is a citation multiplied — and the door that guards a permission nobody can hold — 2026-09-24

Two halves, and the second one is the reason for the first.

### 1. The gate

`PermissionVocabularyTest` asks the running router, through the handler methods Spring registered, which
permissions its `@RequiresPermission` guards name — and asserts that every one of them is inside the union of
the seven role presets plus `API_KEY_SCOPES`. That is the D42 failure mode stated as a subset relation: a route
guarding a permission no preset contains answers 403 to everyone forever, with a 200-shaped contract row, a
working controller and a green suite beside it, because `reconcileGrants` copies a preset, `ApiKeyService.create`
422s an unknown scope, and the seed writes the owner preset — so there is no write path from that string to a
grant row.

The assertion is reflection rather than a grep for a reason worth repeating: the same claim is written two ways
in this codebase — `value = "read_analytics"` and `value = MerchantPermissions.READ_ANALYTICS` — and only the
evaluated annotation says what the interceptor will compare. It is a Java test rather than a `quality.sql` row
because the vocabulary lives in Java, and a SQL check could only re-derive it by hand-copying twelve strings into
the seed directory. That is how D42 found two doors printing one person's access differently; a third copy would
have been the same defect wearing a different hat.

And the subset check is guarded the way D42's rules said a check has to be: the four permissions whose absence
broke the demo — `admin_members`, `configure_ai`, `read_analytics`, `send_message` — must be *observed* before
the containment is believed. Against a router that registered nothing (a failed component scan, a wrong profile,
an exception earlier in the same run) `enforced` is empty, `containsAll` passes, and the gate certifies the
vocabulary as sound. D41 met that trap from the outside — a reconciliation measured against an empty router
proves only that the router was empty — and a subset assertion is the same trap one level in.

Whether either assertion can fail was then measured, by mutating a route annotation and the file restored the way
D43's mutations were (absolute paths, backup, restore in the same shell, and a `grep -c` proving the markers
were gone):

```
"configure_ai" → "configure_ai_unheld" on POST /ai-agent/config   → enforcedPermissionsAreAllGrantable red
merchant = "apikey:id" → "keyid:id" on DELETE /api-keys/{id}      → merchantScopesResolveOrFailAsAClientError red
```

That second test is the other half of the same table, and the mutation shows what it catches: `WorkspaceAccess`
answers a `merchant()` kind it does not recognise with `ApiException.internal`, so one mistyped prefix in an
annotation converts a documented, RBAC-declared, working-looking route into a 500. Twenty-seven specs across
eight kinds are in the working tree now. The test does not carry a list of the kinds it accepts — it calls the
resolver with an empty request and requires the failure to be a 4xx, which makes `WorkspaceAccess` the source of
truth for its own vocabulary. A copied prefix list would have gone stale the first time someone added a ninth
kind, and would have gone stale by *passing*.

### 2. The citation

Five comments in three packages said, in one form or another, that `permission_grants` is authorisation's source
of truth **because D5 says so**: `RequiresPermission`, `PermissionService`, `MerchantWorkspaceController`,
`MerchantWorkspaceService`, `MeController`. `grep` of D5 for the word `permission_grants`: **0 matches in its
five lines.** D5 is "Auth & tenancy" — stateless JWT plus the session cookie, no card data ever, the
`tenant_id` predicate on every repository, and 404-instead-of-403 — which is why the other sixteen D5 citations
in this service are all correct: every one of them is about tenancy, enumeration or card data.

Where the wrong one came from is the part to keep. This decision's own entry, D40, opens its rules section with
"**The rule the doors have to honour is D5.**" The comments were faithfully copying their parent. Nothing
verifies a citation; copying one multiplies it, and a wrong number in a decision log becomes a wrong number in
code the first time somebody writes the door it describes. D43 is the proof: it deleted one of these five —
`PermissionService`'s "(D5, AGENT_CONTRACT §8)" — and its replacement sentence added a sixth, "(D5's preset
reading)", in the same file in the same edit. The mechanism kept running while the mechanism was being described.

All five now cite D40, whose rule it is. The sentence in D40 was **not** edited away: an amendment line was
placed directly above it, saying what is wrong with the line below and what replaced it. The log keeps what was
believed on 2026-09-23, and the correction sits at the exact place a copier would pick up the error — which is
the only property that makes an amendment useful.

One overreach in the same sweep was not a citation at all. `Principal`'s javadoc declared its `subjectType`
"matches the `permission_grants.subject_type` domain: `user` | `merchant_user` | `agent` | `api_key`" — the
column's whole domain, as if every value in it were a subject this build authenticates. Measured: exactly two
`new Principal(...)` sites exist, `AuthFilter` (`user`) and `ApiKeyService.verify` (`api_key`).
`merchant_user` is a spelling a *row* is filed under, not a principal — which is why D40's union is over rows —
and `agent` has no reader (D43). The comment now says which two authenticate, which two are row vocabulary, and
why. What that leaves visible is `AuthorizationInterceptor`'s branch for a principal whose `subjectType` is
already `merchant_user`, which no authenticator can produce: dead today, harmless, and left alone — narrowing
the authoriser on the strength of a comment is how a gate quietly starts accepting less than it appears to.

```
PermissionVocabularyTest            new · 2 tests · suite 140 → 142
mutations that reddened it          2 markers, 2 distinct assertions, 0 left in the tree
grants claims citing D5             5 sites → 0   (4 copied from D40's own line, 1 re-created by D43)
16 other D5 citations               left alone — every one is about tenancy, enumeration or card data
merchant() specs the resolver must understand   27 across 8 kinds
```

What this does not do: it does not gate the *reverse* direction — "every permission a preset can grant is asked
for by some route" — because that check would be a lie in this tree. Five of the twelve are today enforced only
by untracked files (`MerchantContentController`, `MerchantImportController` and the rest of another wave's
in-flight work), and three more are enforced by no file at all; an expected-set table built from what happens to
be on disk would flip verdicts when that wave commits or reverts, which is D41's "measure against an empty
router" in reverse. `create_reservation`, `create_draft_campaign` and `publish_campaign` are those three, and
§5's campaigns rows are already in the "documented, not served" ledger their owner works from. And no new route
was added, so the contract ledger is §38's, unchanged.

## D45 A key nobody required is not an absent key — it is one shared literal, and the promise has two halves — 2026-09-24

### 1. What shipped

`IdempotencyService.run(scope, key, owner, work)` claims a row keyed by the scope and the caller's header
together, and on a conflict it hands back whatever the first claimer stored. `@Idempotent(scope = …)` is what
makes `AuthorizationInterceptor` demand that header. `POST /api/v1/admin/moderation/{id}/resolve` had the first
half and not the second: it wrapped its decision in `run` and never declared the marker. So a resolve that
arrived without a header was not "un-idempotent" — it claimed the literal `moderation_resolve|null`, one row
shared by every keyless caller of that route.

Three faces, measured by running the shipped code with the marker deleted and the guard neutralised
(`ModerationFlowTest.keylessResolveIsRefusedAndLeavesItsCaseOpen`):

- the first keyless resolve answered **200** and did its own work — and wrote the shared claim, which is the
  whole problem, since nothing about that response says a second caller will be answered from it;
- a keyless resolve by a **different** platform account afterwards answered **409
  `idempotency_key_conflict`**: a reviewer who never touched the queue is locked out of the route until the
  24-hour TTL ends;
- a keyless resolve by the **same** account is answered from the stored row without executing anything
  (`idempotent_replay: true`). That face is measured at the service, in `IdempotencyPairingTest` — over HTTP it
  is unreachable once the marker exists — and it is the one that matters most: the console would print a
  decision, a `resolved_at` and a `before`/`after` pair for a case nobody decided (§109).

### 2. Two halves of a fix, because two halves failed

The route now carries `@Idempotent(scope = "moderation_resolve")`, so a keyless resolve is a 422 naming the
header and the scope, and nothing is claimed, closed or audited. And `run` refuses a null or blank key with a
500 that names the declaration it wants, because the marker is one line a later edit can lose: with the marker
deleted and only the guard in place, the same request answers **500**, measured — loud and specific instead of
quietly shared. The 500 is deliberate. No client can reach it by what it sends; what it reports is a handler
that asked for a replay without asking for the key.

### 3. The gate reads the source, which is the opposite of D44

D44's rule was *ask the resolver rather than copy its vocabulary*, and here there is no resolver to ask: which
handler wraps its body in `run` is a fact about a method body, invisible to reflection, and the two halves of
the promise sit centimetres apart in one file. So `IdempotencyPairingTest` walks `src/main/java` and asks the
mechanical question — every `.run("<scope>", …)` has an `@Idempotent(scope = "<same>")` above it in the same
file — and names what it finds: `ModerationController.java:143 runs scope 'moderation_resolve' with no
@Idempotent`. The walk opens with an assertion that the source directory exists, because a scan whose root had
moved would pass by finding nothing (D44's non-zero guard again).

One direction only, on purpose. A marker with no `run` asks a caller for a token it does not use: wasteful,
harmless, and `POST /api/v1/reservations` is the served example of the shape — it demands no header because
`reservations_slot_user_uniq` (V2) already settles a retry, answering 200 instead of 201 with the same code and a
`status_note` that says the hold was reused. A
`run` with no marker corrupts an answer. Only the second is refused.

### 4. And §1's list, copied

`API_CONTRACT` §1 said the header is required "on checkout, payment, reservation create, review create, campaign
publish", and `Idempotent`'s javadoc reproduced those five verbatim — D44's mechanism with a decision number
replaced by a section number. Measured: one of those five is served and requires it (review create); checkout,
payment and campaign publish have no route in this build at all — nothing in `src/main/java` references
`CartService` — and reservation create asks for no key by design. Four served replays are not in the list
because the list predates them. §1 now names the five this build answers a replay for, says what guards a
retried booking, and says which three are waiting for their routes.

```
IdempotencyPairingTest              new · 2 tests · ModerationFlowTest 4 → 5 · suite 142 → 145
mutations that reddened them        3 (marker off / guard off / both = the shipped code) · 0 left in the tree
recorded replays in src/main/java   5 · paired before this unit 4 · after 5
§1's five doors                     served 2 of 5 · requiring the key 1 of 5 · 4 unlisted doors already required
faces measured                      200 + shared claim · 409 for the second account · replay for the first
```

What this does not do: it does not gate the reverse pairing, for the reason above. It does not require a key on
reservation create, which is protected by an index rather than by a stored response — §1 now says so instead of
the code pretending otherwise. And it does not guard `IdempotencyService.headerOnly`, which builds a string
rather than a claim: the checkout route, when `com.nexus.commerce` grows one, will need either this marker or
its own decision about a null key, and that is that stream's call to make. `com.nexus.admin`'s one red test and
the 25 documented-not-served rows are unchanged and still theirs.

## D46 A window nothing reads is not a window — and a config key nothing reads is an offer withdrawn in silence — 2026-09-24

### 1. What shipped

`IdempotencyService.run` wrote `expires_at = now() + nexus.idempotency.ttl-seconds` onto every claim and nothing
in the build ever compared that column with `now()`. Measured at D45's own commit: four files name
`idempotency_keys`, and exactly one line among them mentions its `expires_at` — that insert. The pattern was
already in the house for `facts`, whose §20 freshness TTL has its companion read in `FactRepository`
(`f.expires_at is not null and f.expires_at < now()`); this table simply never got one. So the window was a value
stored for a reader that did not exist,
and three things followed, each measured by deleting the read again (mutation 1, i.e. the code as it stood at
D45):

- an `in_progress` row left by a process that died between claiming and completing had one exit — the delete in
  `run`'s own `catch`, which a dead process never reaches. Every later retry of that key answered **409
  `request_in_progress`** with no end: the measured third attempt said so in those words, and the only way out
  was an operator's `delete`.
- a `completed` row replayed for as long as it existed, so the setting moved nothing. `NEXUS_IDEMPOTENCY_TTL=60`
  and `=600000` were the same service.
- a second account colliding on a key was refused **409 `idempotency_key_conflict`** forever, not "until the TTL
  ends" — which is the phrase `API_CONTRACT` §1 prints, the phrase D45 §1 printed, and the phrase D45's own
  `STATUS` closing paragraph repeated as something that happens *on its own*. D45 wrote those sentences about a
  read that did not exist. They are true from this commit; D45 is left as written, because the behaviour it
  describes is now the behaviour the code has, and §40's sentence is corrected where it stands.

### 2. The fix is a comparison, not a janitor

```java
int inserted = claim(claim);
if (inserted == 0 && jdbc.update("delete from idempotency_keys where key = :key and expires_at < now()") > 0) {
    inserted = claim(claim);
}
```

An insert that loses to an existing row asks whether that row is still inside its window; if it is not, the row
is dropped — it answers no one, which is the whole content of being expired — and the caller tries to own the key
again. Concurrency is settled by the same statement that settled it before: the re-insert is `on conflict do
nothing`, so the retrier that wins runs the work and the one that loses falls into the existing branch, where the
fresh row says `in_progress` and it is refused. Nothing about a *live* claim changed, and mutation 2 (the same
reclaim with `and expires_at < now()` deleted, so any conflicting row is dropped) reddens all three new tests
precisely because that is the one thing that must not happen: a live claim stolen mid-flight is the double
execution this table exists to prevent.

There is no sweeper. This service has no `@Scheduled` method, no scheduler bean and no job table, and a timer that
deletes rows behind a request's back is the same species of promise this increment is about — one whose firing
nothing witnesses. So the window is enforced lazily, by whoever touches the key next, which removes every
correctness face above and leaves one operational face: a claim for a key nobody ever retries stays on disk past
its window and costs storage. It cannot cost an answer.

### 3. What the window is traded for

Inside it, a retried key is an answer. Outside it, a retried key is just a string, and the work runs again — that
is what §1's TTL *means*, and it is the reason the reclaim was safe to write. What keeps the second run from
duplicating anything is the resource's own integrity, which this project has been building row by row:
`moderation_cases` refuses a second decision (`case_already_resolved`, D39), `reservations_slot_user_uniq` (V2)
refuses a second live hold per person per slot, and `reviews` guards nothing — a review reposted after its key
expired is a second review, which is also exactly what a day-later second post is.

### 4. The second gate: `ConfigDecorationTest`

The same shape of defect sits in `application.yml`: a key is an offer to an operator, and a key nothing reads is
that offer withdrawn in silence. The gate walks the top-level `nexus:` tree in `src/main/resources/*.yml` by
indentation and asks, of each leaf, whether any `@Value` in `src/main/java` names it. Its first run found
`nexus.deletion.grace-days` unread — and the reason is the interesting part: `DELETE /api/v1/me` tells its caller
"a deletion_request row was created for the retention job (§106)", and this build has no retention job, so the
30-day grace is an intention recorded in a file nothing opens. Implementing it means **scheduling irreversible
data destruction**, which is a human decision and not a default, so the key is exempted with that reason written
into the test and the gap is reported here rather than quietly built. Exemptions are not free: each must carry a
non-blank reason, must still be declared, and must still be unread — an exemption that outlives its key, or that
a later wiring-up makes stale, is a comment about a file that no longer exists (D43's lesson about a dated row,
applied to an allowlist). Mutation 3 misnames the exemption (red: "config an operator can set with no effect"),
mutation 4 renames the parser's root so it finds nothing (red: the non-zero guard), and the gate reads one
direction on purpose — a read key with no declaration still works through its own default, and several
(`nexus.llm.api-key`, `nexus.oauth.*`) are meant to arrive from the environment rather than from a file in the
repository.

```
IdempotencyWindowTest            new · 3 tests · all red with the read deleted, all red with the predicate widened
ConfigDecorationTest             new · 1 test · nexus.* leaves declared 25 · of them read 24 · exempted 1, with a reason
                                 and 10 read by code but declared nowhere (a default, or the environment)
mutations run                    4 (read off / predicate off / exemption misnamed / parser root renamed) · 0 left in the tree
abandoned-claim witness          an in_progress row written by the test in the shape run writes it, then aged by hand
suite                            145 → 149 run · the 1 red is com.nexus.admin's, unchanged and theirs
```

The tests age a claim with `update … set expires_at = now() - interval '1 hour'` rather than by sleeping or by
configuring the TTL to one second, because the window is a fact about that column: sleeping is not a test, and a
one-second TTL would measure the property binding instead of the read. `age` asserts it updated exactly one row,
since an update that matches nothing is silent — the same objection D43 raised against a predicate with no witness
that can fail.

What this does not do: it does not sweep abandoned rows, as §2 says. It does not add a `CHECK` on
`idempotency_keys.status` (V1 has none), though the reclaim makes a stuck status non-terminal for the first time:
a row that says anything but `completed` now stops refusing callers at its deadline instead of permanently. It
does not touch `AuthorizationInterceptor` or `headerOnly`, both another wave's. It does not build the retention
job, and its absence — like `@RequiresPlatformRole`'s thin coverage of the newer admin doors, `com.nexus.admin`'s
red test and the 25 documented-not-served rows — stays in `STATUS` as somebody else's decision to make.

## D47 A rung no request ever produced — and the identity the caller was allowed to type — 2026-09-24

### 1. What shipped

`API_CONTRACT` §1 has printed `429` + `Retry-After` + `X-RateLimit-Remaining` since that document's first commit
(`7591852`, line 29), and `RateLimitFilter` has been registered on `/api/v1/*` since the day it was written
(`e237f6d`, `FilterChainConfig.rateLimitFilter`). The rung had still never happened anywhere this build is
checked: `rg -n "429|TOO_MANY_REQUESTS|rate_limited" services/platform/src/test/java`, taken from the tree this
unit started in, returned **zero** hits across its 149 tests, and the only place the word `ratelimit` appeared
under `src/test/java` at all was `NexusIntegrationTest` setting `nexus.ratelimit.enabled=false`. A promise that
the shared harness switches off is a promise no test can see, which is how a contract line and a filter can both
be true and the behaviour still go unwitnessed for every increment since.

The 429 was the easy half to fix. What it guards is the reason it mattered.

### 2. Two layers of the same trust, and the third thing it touched

The login gate's entire value is that it stands in front of the password check. Its bucket key was
`Req.clientIp(request)` — and that method answered with the first entry of `X-Forwarded-For` whenever a caller
sent one, falling back to the socket peer only when they did not. One line of configuration then did the same
thing underneath the application: `server.forward-headers-strategy: framework` in `application.yml`, which
registers Spring's `ForwardedHeaderFilter` and rewrites `getRemoteAddr()` from that same header, for any peer,
declared or not. So fixing the Java and leaving the config alone would have produced a fix that changed nothing
a client could observe.

Three consequences. The first and third are met directly on the pre-D47 configuration — `ForwardedHeaderTrustTest`
runs `framework` deliberately, with a limit of one — and the second is met up to the point where proving the rest
of it would need a second machine:

- a spent budget refills for whoever types a new address. Four failed logins → one refusal and three handler
  visits, because the window refilled every time the claimed address changed. The only attempt the gate stopped
  was the one reusing an address it had already spent.
- the same header lets one caller spend **another client's** budget: two attempts naming `203.0.113.11` and the
  second is refused. What follows for the address's real holder — arriving later, from the socket that actually
  belongs to it, into the window the spoof already drained — is an inference from the key being a string, because
  no test on one machine can arrive from anywhere else; §4 is why that limit is written down rather than hidden.
- `audit_logs.ip` recorded the typed string. This one is worse than bad attribution: the column is `inet`, the
  insert is `cast(:ip as inet)`, and `AuditService.record` catches every exception by design (a broken audit
  write must not turn a successful action into a 500). So `X-Forwarded-For: anything-not-an-ip` destroyed the
  audit row for whatever had just happened, logged nothing but `audit_write_failed`, and still returned the
  response — including for `permission_denied`, which `AGENT_CONTRACT` §8 makes part of the denial itself. An
  untrusted header was therefore both the identity and a switch for whether the trail exists: the framework
  class sends `X-Forwarded-For: not-an-ip` and asserts the login answered 401 while **no row at all** is left for
  its tenant, and the fixed configuration sends that same value and asserts the row is there, holding the peer.
  The witness rides the login path because that is the door an anonymous caller can reach; `denied` passes the
  same argument through the same insert, so a denial's row was one header away from the same fate.

### 3. The fix is two lines, and one of them is not code

`Req.clientIp` now returns `request.getRemoteAddr()` and reads no header. `application.yml` now declares
`${NEXUS_FORWARD_HEADERS_STRATEGY:native}`. The choice between those two words is the whole decision, and it was
measured rather than recalled: asking the running container with the strategy set to `native` shows
`RemoteIpValve` in the engine pipeline, and the default `server.tomcat.remoteip.internal-proxies` value (read out
of Boot 3.5.16's own configuration metadata, matching the regex compiled into tomcat-embed-core 10.1.55) is the
loopback, private, CGNAT and link-local ranges. `framework` honours `X-Forwarded-For` from whoever sends it;
`native` honours it from a peer the operator declared to be a proxy, and rewrites the address once for every
reader of it — the rate bucket, `audit_logs.ip`, whatever comes next — instead of each reader deciding for
itself whether to believe a string.

`DeclaredProxyTest` is the counterweight, because "untrusted" that nobody can switch on is a broken feature
rather than a policy: with localhost declared as the proxy, the named client does get its own bucket and does
land in the audit row. The same four requests answer differently in those two classes, and the only difference
between them is that declaration. And a third gate reads the shipped files
(`shippedDefaultRefusesTheHeaderFromAnyoneButAProxy`): any `forward-headers-strategy` declaration in
`src/main/resources` must resolve to `native` or `none`, and must be `${ENV:default}` so an operator behind a
proxy can say so without editing a file. That gate is what stops the config half of this fix from rotting back
into a one-word edit.

### 4. What witnessing a 429 took

- **A probe before the promises.** Every assertion in `RateLimitEnforcementTest` is silently true if
  `nexus.ratelimit.enabled=false` wins the precedence fight against the subclass's `@TestPropertySource`, so the
  class opens by asking the limiter itself to refuse one request on a private scope, and that assertion's failure
  message says exactly what a green-means-nothing outcome would be. (It does win: the inlined properties of a
  test class outrank the parent harness's `@SpringBootTest(properties = …)`.)
- **A count of what did not happen.** The refusal is proven to sit in front of the route by the audit table —
  seven attempts, three `login_failed` rows — not by the status code alone. A 429 that still reached the handler
  would look identical to a client and identical to this test if the count had not been taken.
- **Two traps, both of them this unit's own reds, both of them worth writing down.** `@TestPropertySource`
  inlined properties lose their backslashes on the way to the container: the proxy pattern
  `127\.\d{1,3}\.\d{1,3}\.\d{1,3}` arrived as `127.d{1,3}…`, matched nothing, and the test that was meant to
  prove a declared proxy works went red for the test's own syntax rather than for the product. The patterns in
  these classes are escape-free (`127.*`) for that reason. And an `inet` rendered with `ip::text` is
  `127.0.0.1/32`, not `127.0.0.1` — the assertions read `host(ip)`.
- **Three more Spring contexts**, one per (strategy, proxy-list) pair, because these are facts about the
  container and a container cannot be reconfigured between two methods of one class. One in-memory
  `KeyValueStore` per context is also why each class spends a distinct scope: the buckets are shared by every
  method in the same class.
- **Why the tests have to declare the proxy list themselves.** Every test here connects over loopback, and
  loopback is inside `native`'s default internal range — so a loopback client sees the *same* behaviour under
  `native` as under the old `framework` default, and only the declared pattern (`192.168.*`, which these
  requests never arrive from, versus `127.*`) separates "the header is inert" from "the header names me". The
  distinction this unit is about lives in what a *remote* peer's header does, and no test on one machine can
  produce a remote peer; it can produce the declaration, and it can refuse a shipped file that trusts without
  one. A walk from `127.0.0.1` could never have caught this bug, and the rung step added to `e2e_fresh.sh` says
  so in its own comment rather than claiming a proof it cannot give. It also reads the window from the service's
  own `X-RateLimit-Limit` instead of assuming it, because the first version assumed: twelve attempts against the
  10-per-300s the base file advertises produced no refusal, and the reason was that `application-dev.yml` — the
  profile that script boots under — re-declares `auth-requests` as a bare literal `100`. A step that counts on a
  number another file may overrule quietly stops testing anything, and the failure is worth more than the pass
  would have been: it is D46's defect one layer up, with the base file offering `${NEXUS_RL_AUTH:10}` and a
  profile silently overruling it, and it is D48 rather than a footnote here.

```
mutations  5, each caught red, each restored and the restore verified against git; the final suite re-greened
           the whole tree (clientIp→header · strategy→framework · Retry-After deleted · write bucket per IP ·
           window one request late)
tests      8 new across 4 classes · suite 149 → 157 run · the 1 red is com.nexus.admin's, unchanged and theirs
e2e        a 9th step; the running service declared its own auth window as 100 per address — not the 10 the
           base file advertises — and refused the ladder on its 95th attempt, envelope and headers intact
```

The five: `Req.clientIp` back to reading the header (red in `ClientIpTest` **and** in the ladder's audit
assertion); the shipped strategy back to `framework` (red in the config gate **and** in the ladder, which is the
proof that the config line is load-bearing and not just the Java); the `Retry-After` header deleted from the
filter's refusal (red on §1's own words); the write bucket re-keyed onto the client address instead of the
principal (red on "the second person's first write is not the first person's fourth"); the window made to
refuse one request late (red in all three methods of the class, including the vacuity probe).

What this does not do: it does not witness the `ai` scope — no test drives `/api/v1/ai/**` with the limiter on,
so those 20-per-60s numbers are read from the config and not from a refusal. It does not remove the trust that
`native` still gives to a peer inside the private ranges, which is what the declaration means; `infra/` runs no
proxy, so an operator who exposes this port directly and keeps the default list is making a choice this unit
documents in the file rather than one it can prevent from here. It does not touch `TenantFilter`'s use of
`X-Forwarded-Host`, which is a sibling read of an untrusted header but not the same kind of thing: choosing a
tenant is public in §1 (`X-Tenant` exists precisely to name one), choosing an *address* is not. It does not
delete `RateLimiter.require`, which has no caller in this build. And `rate_limit_buckets` — the V1 table no SQL
and no Java in the repository writes, while another stream's types cite it as provenance twice over
(`packages/types/src/admin.ts` for an admin metric, `packages/types/src/errors.ts` for a "scope key the bucket is
charged to", which in this build is a `KeyValueStore` key and never a row) — stays reported, not reconciled.

## D48 A profile that closes an offer the base file makes — 2026-09-24

### 1. How it was found

By being wrong loudly. The rung step D47 added to `e2e_fresh.sh` laddered twelve failed logins against the
10-per-300s window `application.yml` advertises, expected a refusal inside that, and got none — so its own `die`
fired on a real boot. The service was not ignoring the limiter: asked for its own window through
`X-RateLimit-Limit`, it said **100**. `application-dev.yml` — the profile `run_platform_dev.sh` defaults to, and
therefore the profile every local instance and this script runs under — re-declares the three rate-limit
quantities as bare literals, "generous, so manual curl sessions do not get throttled".

That phrasing is fine. The way it was written is not: a profile document outranks the base file for the whole
environment, so a bare `auth-requests: 100` silently beats the base file's `${NEXUS_RL_AUTH:10}`. An operator who
exported the variable the base file names got the literal, and nothing said so — the same defect D46 named one
layer up. D46 was a key no code read; this is a key code reads, through a file the operator cannot reach.

Measured over the whole `nexus:` tree of that profile: six leaves, all six re-declaring a leaf the base file
backs with an environment name, and **four** of them closed the offer — `ratelimit.auth-requests`,
`ratelimit.write-requests`, `ratelimit.ai-requests`, and `demo.login-enabled`.

The last is the one that earns the unit. `nexus.demo.login-enabled` is the switch that turns §87's passwordless
demo sessions off (`AuthController` refuses the door and names the setting), the base file offers it as
`${NEXUS_DEMO_LOGIN:true}`, and the dev profile pinned it to `true`. On the profile that runs the demo, the
switch that disables the demo could not be disabled. The value was already `true`, which is exactly why no
behavioural test, no gate and no reader noticed: closing an offer is invisible as long as nobody tries to take
it up.

### 2. The fix, and why reading the file is not enough

The four literals became `${NEXUS_RL_AUTH:100}`, `${NEXUS_RL_WRITE:300}`, `${NEXUS_RL_AI:100}` and
`${NEXUS_DEMO_LOGIN:true}`: same defaults, dev's generosity intact, the environment back in play.

`ConfigDecorationTest` gained a second gate for the class of it rather than for these four lines — every leaf a
profile re-declares must keep the base file's `${ENV:…}` shape — with two guards against the gate going green by
inspecting nothing: the profile list must be non-empty, and the count of overlapping leaves must be positive.
That count is not decoration. The first mutation aimed at it (stripping the `${}` from the four base leaves)
left the gate green, because `nexus.redis.url` and `nexus.jwt.secret` overlap too and the guard still had two
comparisons to stand on; the guard only speaks when the profile stops declaring anything the base file offers,
which is the second mutation and does turn it red, on its own line, with its own message.

A file-shape gate proves the placeholder came back, not that the value arrives. `DevProfileRateLimitTest` boots
with `@ActiveProfiles("dev")` and `NEXUS_RL_AUTH=2` and asks the service: the filter printed
`X-RateLimit-Limit: 2`, spent the window on the second attempt and refused the third, and the audit table counted
two handler visits for three requests. Reverting one dev line to a literal reddens both classes at once — the
gate reading the file and the measurement reading the wire — which is the pairing this project asks for before it
calls a configuration fixed.

```
mutations run    3 · one dev leaf back to a literal (red in the gate AND in the runtime class) ·
                   the demo switch likewise (red in the gate) · the profile's nexus block renamed (red on the
                   overlap guard, which is the guard's own witness)
tests            2 new (ConfigDecorationTest's second gate + DevProfileRateLimitTest) · suite 157 → 159
contract         §1's rate-limit bullet now says what a dev boot starts at, that the `NEXUS_RL_*` names still
                 work, and which doors the `ai` scope can actually reach — §42's sentence had copied the filter's
                 two prefixes without asking the router, and §7 says `/api/v1/ai/**` is never served here
e2e              PASS on the restored config: the service's own header still says 100 per address (defaults
                 untouched), the ladder was refused on attempt 95, and the ledger is unmoved at 121 of 133 in
                 scope / 96 declared / 25 documented-not-served / 0 served-undocumented
```

What this does not do: it does not change a default — dev still starts at 100/300/100 and demo login is still on
locally, so no served behaviour moves for anyone who sets nothing, and the §87 demo walk in the e2e is unchanged.
It does not decide whether a profile should ever be allowed to pin a value: a deliberate pin is legitimate, and
when one arrives it has to be added to this gate with a reason, the way `UNREAD_BY_DESIGN` makes its exemptions
pay for theirs; there is no exemption list yet because none is needed. It does not reach `spring.*` or `server.*`
leaves — the gate walks the `nexus:` tree, which is where this build's own offers live. And the `:8090` instance
another session may restart from this working tree keeps demo login on, because the default it now honors is
`true`; turning it off is an export away rather than an edit, which is the whole point, but nobody has done it.

## D49 A filter line that could only ever meter a 404 — and the rung behind another stream's door — 2026-09-24

### 1. What shipped

§1 promises three scopes, and `RateLimitFilter` declares two of its prefixes as paths. Only one of them is
served. The AI scope charged `path.startsWith("/api/v1/ai/")` as well as `/api/v1/merchant/ai-agent`, while both
of this service's own descriptions say the first is somebody else's surface: `OpenApiConfig` describes the
document as covering commerce and adds that "AI surfaces (`/ai/v1/**`, `/mcp`, `/api/v1/ai/**`) belong to the AI
service", and `API_CONTRACT` §7's own row says "the platform service never serves `/api/v1/ai/**`". Asking the
running router for its registered patterns agrees — none begins with that prefix.

So the line did exactly one thing: meter traffic that then 404s. Not harmless-neutral, either — it is what made
§1's "AI-ish endpoints per principal" read as coverage of AI endpoints, and D47 fell for it: §42's sentence about
the scopes copied both prefixes straight out of the filter, which is D44's failure (a citation copied is a
citation multiplied) arriving in prose rather than in code. §43 caught it; this unit removes the source of it.

### 2. The change, the gate, and the fact the first version of the witness was wrong

The dead prefix is gone, the door stays. `RateLimitScopeRoutesTest` is the durable half: it reads the
`path.startsWith("…")` literals out of the filter's source — not from a list kept here, because a list drifts —
asks `RequestMappingHandlerMapping` what is actually registered, and refuses any prefix nothing is served behind.
It checks the `/api/v1/` routing guard the same way, since a prefix is a claim about traffic whatever it is used
for. Two guards keep it honest: the literal list must be non-empty and the router must report more than fifty registered paths,
because a refactor that moves those strings into constants would otherwise leave the gate comparing nothing and
passing.

The HTTP witness for the scope is `RateLimitEnforcementTest.aiScopeCountsPerPrincipal`, and writing it produced a
fact nobody had written down: a mutating request to the AI-agent door is charged to **two** windows at once, `ai`
and `write`. The first version POSTed there and was refused on attempt two — by this class's `write-requests=1`,
not by the `ai` window it was meant to measure. The test now uses a non-mutating request so the two scopes cannot
collide, and §1 states the overlap out loud, because "one request, two budgets" is the kind of thing a client
finds out the hard way.

`ai_unavailable(503)` is §1's other rung and had never been produced anywhere either — the same silence D47 found
behind `429`, with a different cause. Its only raisers are two `catch` blocks in `HeuristicImportAdapter.fetch`
(tracked, in this build), and the doors that reach them — `MerchantImportController`, `MerchantContentController`
— are untracked files owned by another live stream. So the rung gets a seam witness at the boundary this build
does own: an unroutable source answers 503 `ai_unavailable`, an internal host answers 422 before anything is
dialed (the DNS-rebind rule the code cites as AGENT_CONTRACT §3's), and a non-http scheme answers 422. Asserting
all three together is what stops the first from being satisfied by a guard that refuses everything. That the
rung is unreachable over HTTP from tracked code stays a report, not an invitation to edit somebody else's
controller to make a test pass.

```
mutations run    5 · prefix re-added (gate red on its own line) · ai line deleted (HTTP witness red) ·
                   ai bucket keyed per address (the per-principal assertion red) · 503 branch answers a
                   different rung (seam witness red) · prefixes moved into constants (reader guard red)
tests            3 new · suite 159 → 162 run · the 1 red is com.nexus.admin's, unchanged and theirs
e2e              PASS with the line deleted: 525 served reads, the three walks at 30/30, 15/15 and 22/22,
                 the rung refused on attempt 95 of the service's own 100-wide window, ledger unmoved at 121
                 of 133 in scope / 96 declared / 25 documented-not-served / 0 served-undocumented
```

Two of those five took more than one try, and the record is worth more than the count. The 503 mutation did not
compile — `ApiException.validation` takes a details map and the first attempt passed a bare string. The reader
guard stayed green twice running: first because only one of the file's three literals had moved, then because
the mutation I had written did not actually move any; it took constants for all three before the guard spoke. A
green you did not expect is a measurement you have not finished, which is the same lesson D43 wrote about
predicates, applied to mutations.

What this does not do: it does not add an AI surface to this service — whether `/api/v1/ai/**` should exist here
at all is a routing decision about the BFF split §7 documents, not something a filter line can settle. It does
not reach the `503` over HTTP; that needs another stream's controller, so the seam gets the witness and the gap
gets this sentence. It does not make the two-scope charge nicer — a request that matches two scopes still spends
two windows, now documented rather than discovered. And it leaves the standing reports where §43 put them.
