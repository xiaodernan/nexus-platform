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

**Corrected by D61, in part.** The route is served now, and what it serves is a draft: `visibility='private'`,
`published_at` null, so it creates no publishable consumer page and therefore needs none of the authority this
paragraph is waiting for. The wait itself was also mis-described — `collections` carries `tenant_id` and
`author_id` and no merchant column, so there is no workspace permission chain that *could* guard a row this schema
cannot attribute to a workspace (D50 measured that). What remains unbuilt is the verb that publishes, and D61
asserts its absence off the running router rather than off this sentence.

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

## D50 A door no test ever opened, and the two things it hid — 2026-09-24

### 1. What shipped

`grep -rn "favorites" services/platform/src/test/java` returned **nothing**: three documented handlers —
`GET`, `POST` and `DELETE /api/v1/me/favorites` — had never been called by a test, and the §7 row that documents
them had an empty description cell. That is the shape D42 keeps returning to: an undocumented row and an
unwalked door are the same gap seen from opposite sides, and each one lets the other stay invisible, because a
row that promises nothing is never contradicted by a handler that does something.

Walking it found two defects, neither of which is about the response shape.

### 2. What the door hid

**A favourite could point at a row nothing can open.** `assertSubjectInTenant` — the validator the POST calls
before it saves — accepted *any* collection in the caller's tenant. §8's own read path hides rows that are not
`visibility='public' AND published_at is not null` and attributable, so the saved item and the directory disagree
by construction, and the disagreement is a user-visible one: a card in the favourites list whose link answers
404.

One correction, self-reported, because the sentence I first wrote here overstated it. I measured 31 public
collections with no `published_at` and 31 more stamped but with neither an author nor a provenance token, out of
576 rows — in `nexus_test`, which is the **shared test database**, and those rows are fixtures the suites leave
behind, not demo data. The seed's own count is in the file that loads it: `data/seed/out/22_collections.sql`
says "loads public.collections (4 rows)", and all four carry a stamp and an author. So the missing guard was
latent, not live: no demo user has a broken favourite today, and `POST /api/v1/collections` does not exist to
create one. What it is worth is the truth of the shape — `collections` accepts a draft row today (the column
default for `visibility` is `public` and `published_at` is nullable, and D34's gate is a read-side filter, not a
constraint), so the first write path that lands — §8's own `POST /api/v1/collections` — turns a saved pointer to a
404 from latent into reachable without anything else changing. `nexus_test` is the same shared database
whose mutation residue caught D46, and the lesson is the same one: count rows in the file that loads them, not in
a database that several suites write into.

**`guide` was advertised and then refused.** `FavoriteBody`'s own `@Pattern` accepts
`merchant|offering|guide|collection`; the validator had branches for merchant and offering, one for collection,
and none for guide — so the fourth documented value fell through to `422 Unsupported subject_type`. A request DTO
promising what the code under it denies is a smaller copy of the same failure the empty doc row was.

### 3. The fix, and who owns the rule

The publishability check moved to where the rule already lives: `CollectionsRepository` composes its listing
filter, its count and its by-slug read out of the same three fragments, and now exposes the same composition as
`isPublishable(tenant, id, kind)` for the one caller that must not hand out a dead pointer. `MeController` asks
it. The alternative — a second SQL predicate in the identity package that happens to match today — is D44's
defect with a timer on it: two owners of one rule, agreeing by luck, drifting by silence. The kind is passed
through, so a guide id saved as a collection (or the reverse) is refused rather than resolving later as something
else, and the refusal reuses the merchant branch's exact code and message, because D5 says an unreadable row must
be indistinguishable from an absent one.

Both directions are now witnessed by one test that asks the door and the directory about the *same three rows* —
publishable, draft, unattributable — and requires them to agree, plus the kind-pinning case.

```
FavoriteDoorTest          new · 4 tests · save/list/re-save/update-of-same-row/remove, absent-vs-foreign 404s
                          indistinguishable, the three publishability shapes agreed with §8's reads, guide
                          pinned to kind; §7's empty row is now a written contract
mutations run             4 · publishability and kind check switched off (two tests red) · wrong kind passed
                          (guide red) · audit call deleted (red) · on-conflict update → do nothing (red)
suite                     162 → 166 · the 1 red stays com.nexus.admin's
```

Two things this does not do, and both are decisions rather than omissions. It does not change the POST's **200**:
`/reviews` and `/api-keys` answer 201 for a created row and this door answers 200 with none of §7 ever having
said which; the row now says 200, and flipping the status under a client that has been reading 200 since the
route landed is a contract change, not a cleanup (§45 carries it as an open inconsistency). And it does not
resolve the §8 write it exposed on the way: the sentence in §8 claiming `POST /api/v1/collections` waits on the
workspace permission chain is itself wrong, because `collections` has `tenant_id` and `author_id` and no merchant
column at all — no chain can guard a row the schema cannot attribute. §8 now states that measured reason instead
of the imagined one, and the question of who may publish a guide (platform, author, or a merchant once the table
can name one) is left open with `POST /api/v1/share`'s missing link table beside it.

## D51 Two doors that reported success they had not earned, and the logout nobody had asked — 2026-09-24

### 1. The method, this time as a count

D50 found its defects by accident, so this unit went looking: enumerate every `@Get/Post/Put/Patch/DeleteMapping`
in `services/platform/src/main/java`, take each route's last literal segment, and ask whether that string appears
anywhere under `src/test/java`. Of 87 registered `/api/v1` paths, **80 are named by a test and 7 are not**:
`POST /api/v1/auth/logout`, `GET`/`POST`/`DELETE /api/v1/me/saved-searches`,
`GET /api/v1/merchants/{slug}/ucp.json`, `GET /api/v1/merchant/imports/{job_id}` and
`POST /api/v1/merchant/offerings/bulk`. The last two are another stream's untracked files; `ucp.json` is tracked
and has a service-level test but no HTTP one; the four identity doors are this lane, and all four are walked here.

### 2. What walking them found

**Both delete handlers lied about success.** `removeFavorite` and `deleteSavedSearch` call their repository, get
back the number of rows deleted, discard it, and answer `{"status":"removed"}`. So un-saving an id you never
saved reported a removal, and — the case that matters — un-saving *someone else's* row reported a removal while
their row stayed exactly where it was. That is D7's rule inverted: a silent no-op dressed as an accomplishment.
D5 says the honest answer for a record you cannot see is the same 404 whether the row does not exist or belongs
to somebody else, so both handlers now check the count and throw `favorite_not_found` / `saved_search_not_found`
with the "No such record" message the tenant-scoped lookups already use, and neither can be used to probe whose
items exist.

**Logout's promise was three words covering three mechanisms.** §3 said "clears session". Asked over HTTP: the two
cookies come back cleared; `TokenRegistry.revoke(sid)` really does end the refresh family, so the next
`/auth/refresh` is a 401 and cannot mint; the `logout` audit row is written for a principal and skipped for an
anonymous call. And the **access token keeps working to its own `exp`** — 900 seconds by default — because no
request path consults revocation state for a JWT. None of that was written down, and "logged out" is exactly the
phrase a reader takes to mean "this credential is dead now", on a shared browser, at the one moment it matters.

**The comment that described the opposite behaviour.** `TokenRegistry.accept`'s inline comment said an unknown
family is accepted once and adopted, "so a store flush does not lock users out silently"; the code returns false,
which is what the class javadoc and the README's fail-closed trade-off state. The comment was the outlier, and
mutation 5 is what proves which one the build runs: make `accept` fail open and a revoked family mints a new
token pair again, which is the refusal this unit exists to hold.

### 3. The window stays open, on purpose

Closing the access-token gap needs a server-side denylist, and in this build the store behind it is Redis when
reachable and per-process memory when not — a denylist there would be enforced on one JVM and forgotten on the
next, which is D46's silent offer with a security label on it. Short expiry is the mechanism that actually holds,
so §3 now says which parts of "logout" are immediate and which are 900 seconds away. Deciding to add real token
revocation is a deployment decision (it means requiring Redis, or accepting per-node divergence, or moving to
opaque tokens), not a side effect of a documentation unit.

## D52 A seam covered by mocks, and the pointer its own document prints — 2026-09-24

### 1. The third door, and why it looked already covered

D51's count left one route in this lane: `GET /api/v1/merchants/{slug}/ucp.json`. It did not look neglected —
`UcpProfileServiceTest` has four cases, and the suite runs them green. Every one of them stubs
`jdbc.firstForTenant(…)` with a hand-built row, including the row that produces the 200 document, so the door had
never once been answered by the service that owns it. That is the milder-looking cousin of D49's dead prefix: a
promise with tests that cannot fail, because the thing under test is the mock's own fixture.

### 2. What the walk found

Asked over HTTP against the real database, the seam is honest and empty, in that order. `GET /.well-known/ucp`
answers `status: not_integrated` with `capabilities` and `payment_handlers` both empty, cached an hour, and its
`merchant_profiles` field prints `/api/v1/merchants/{slug}/ucp.json` — a pointer that resolves against a route
this build really serves, which is the part no stub can check (D42: a printed field is a promise). The merchant
door answers `404 ucp_profile_not_published` carrying the row an integrating agent would need
(`expected: an agent_profiles row with protocol='ucp' and status='published'`, and the Phase-4 note), so the
absence explains itself instead of shrugging.

And the finding under those: **nothing in this repository can make that 404 into a 200.** No migration, seed file,
service or endpoint inserts into `agent_profiles`; the table is empty in a freshly migrated database and stays
empty, so the only published-profile row anywhere in the build is a Mockito stub. That is consistent with
"reserved seam, hand-off in Phase 4" — but UCP.md said "Nothing here is live today", which is true of the adapter
plan and false of the endpoints, and its §2 spelled the per-merchant path as
`/api/v1/merchants/{slug}/.well-known/ucp` where §1, §10 and the code all say `ucp.json`. An agent reading that
document and integrating against it would fetch a path nothing serves. Both statements are corrected to what the
build does, and the path question — which spelling is the contract — is left as the open decision it already was,
now with the pointer test that keeps the two from drifting silently.

### 3. The gate that asserts an absence

`UcpDoorsTest`'s third case asserts `select count(*) from agent_profiles` is zero, with a message saying who has
to notice it. It reads as an odd test — proof of nothing existing — but it is the mirror of D48's overlap guard
and D43's rule: the claim "this seam has no publisher" is the kind that silently stops being true the day someone
adds one, and then the door's 200 path is the case that has to be written. An assertion that must break at that
moment is cheaper than a mock that keeps passing through it.

```
UcpDoorsTest     new · 3 tests · origin honesty + the printed pointer followed, the explaining 404, the empty table
mutations run    3 · the pointer renamed to a path nothing serves (its case red) · status changed to
                 `integrated` (red) · the 404's details stripped (red)
docs             UCP.md's opening "nothing is live", its §2 path, and its open-questions bullet corrected to the
                 two endpoints and the one spelling the build serves; the decision is left open, the facts are not
suite            173 → 176 · no main-code change, so the e2e leg is not owed by the rule (§47 says why)
```

What this does not do. It does not pick the discovery path — that is a protocol decision with an external spec
attached, and UCP.md's open-questions bullet keeps it open; what changed is that the bullet now states which
spelling is real. It does not build the publisher, and does not pretend the 200 branch is covered by anything
other than a stub. It does not delete the `capabilities.isEmpty()` 500 in `toProfile`: with no publisher that
branch is unreachable from any door, and whether a published-but-empty profile should be a 500, a 409, or
unconstructable is a question to answer together with the publisher rather than in passing.

## D53 The sentence a payload printed and no one read — 2026-09-24

D52 left a question: which printed fields are promises nobody checks? The blunt census says the metric is wrong
— 563 snake_case keys are emitted by `Json.map(`/`out.put(` in the platform, 272 of them named by no test and no
verifier, and that ratio is payload-conformance coverage plus internal metadata, not 272 defects. So this unit
picked by meaning instead: the fields whose whole job is to assert a compliance fact.

`authorisation_basis` is one. Every member write answers with the sentence "permission_grants (admin_members
checked against the caller before this write ran); roles only choose which grant rows exist" — that is D40's
doctrine, shipped in a response body so a screen does not have to infer it from status codes. Nothing tested it,
and it lived in one helper, `withBasis`, that only two of the three doors
called — `DELETE /members/{id}`, which checks the same permission as the other two, never went through it. So a caller who removed a member got the removal's effects without the
explanation the add and the edit both gave, and the explanation itself could drift away from the mechanism with
only a route-behaviour test, somewhere else, noticing.

Now the string is one constant, the removal carries it, and `MerchantWorkspaceTest.theStatedBasisIsTheEnforcedOne`
asserts it on all three doors and finishes by reading `permission_grants` for the removed person: empty. That last
assertion is what makes the test about the claim rather than about the text — a payload that says "the grants are
the access" while the rows outlive the membership would otherwise pass every string check in the file.

```
mutations run   2 · the removal stops carrying the sentence (red) · the sentence rewritten to blame the role
                column instead of the grant rows (red)
docs            §5's member row now names the field, which it never did
suite           176 → 177 · 13 tests in MerchantWorkspaceTest · the 1 red stays com.nexus.admin's
```

The second field this sweep found is a report, not a fix: `PaymentService` prints `card_data_stored: false` and
the §42 "no card data is held anywhere" notice — in `com.nexus.commerce`, another stream's untracked package —
and no controller in this build exposes a payment route, which is why §6 lists `POST /api/v1/checkout` and
`POST /api/v1/payments/{}/confirm` as documented-not-served. The reassurance is therefore currently unreachable
by any client: not a wrong behaviour, but a compliance statement waiting on the doors that would carry it. Worth
one line in §6 when those routes are built, and worth not editing another stream's file to add it now.

## D54 The launcher's list of names to keep, and the three it forgot — 2026-09-24

### 1. Where D48 stopped short

D48 restored an operator's ability to set `NEXUS_RL_*` and `NEXUS_DEMO_LOGIN` on a dev boot, and reported that as
the whole fix. It was not: the same question one layer up — *does the value you exported survive the start of
this process?* — had its own answer sitting in `scripts/run_platform_dev.sh`. That launcher sources `.env` under
`set -a`, and to stop the file from trampling a caller's own exports it captures a list of variables first and
re-exports them after. The list was eleven hand-typed names. The config reads thirty-four.

Measured, not inferred: of the 24 names the keep-list missed, **three are set in this machine's `.env` today** —
`NEXUS_JWT_SECRET`, `NEXUS_LOG_LEVEL`, `NEXUS_DB_ROOT_PASSWORD`. So `NEXUS_JWT_SECRET=some-one-else's-value
scripts/run_platform_dev.sh` printed `caller overrides kept over .env: none` and then booted on the `.env`
secret, with the operator's value gone and nothing on the console to say so. The one variable in the whole tree
whose silent substitution is a security event is exactly the one the list forgot. (The behavioural half of that
sentence was demonstrated by running the launcher with a stubbed `mvn` and reading the environment the JVM would
have received: `caller-wins` before this change, `.env`'s 64-character value with the old list.)

And the reason the list exists at all made a second defect obvious once it was widened: the diagnostic printed
the kept pairs, `KEY=value`, on stderr — and stderr is redirected by whoever calls the script
(`scripts/e2e_fresh.sh` runs it with `>> "$LOG" 2>&1`), so an exported `NEXUS_PLATFORM_DB_PASSWORD`, one of the
original eleven, reached that run's log file. A guard against a credential being *overridden* that was busy
logging the credential. Nothing was leaking on this machine today, because no caller here exports a password on
the command line; the mechanism is the finding, not an incident.

### 2. The fix, and what it refuses to be

The names now come out of the two files the service reads, so there is nothing left to remember:

```bash
for key in $(grep -hoE '\$\{[A-Z][A-Z0-9_]{2,}' \
                   services/platform/src/main/resources/application.yml \
                   services/platform/src/main/resources/application-dev.yml \
               | sed -E 's/^\$\{//' | sort -u) SPRING_PROFILES_ACTIVE; do
```

— and the echo prints names only. `ConfigDecorationTest.launcherKeepsEveryConfiguredOverride` is what keeps it
that way: it reads the real script, requires it to derive from those two files, refuses a re-appearing
hand-typed `for key in NEXUS_…` list, and checks that the variable the diagnostic interpolates is never given
values. Both halves have mutations that go red: swap in the previous launcher and the derive assertion fails;
put `=$`{`!key`} back into the printed variable and the value-echo assertion fails.

Suppressing the values also removed a piece of evidence someone else was reading: `e2e_fresh.sh` proves a
throwaway run is talking to its own database by grepping the launcher's log for the kept-pairs line — exactly
what the redaction took away, and the fresh gate found it on its first run. The banner now carries
`datasource=${NEXUS_PLATFORM_DB_URL}`, a JDBC URL with no credential in it, and the check greps that instead: the
caller's URL is still proven to have survived `.env`, and nothing secret is printed to earn the proof.

What this does not do. It does not validate that an exported name is one the config reads — a caller typing
`NEXUS_RL_AUT=5` still gets nothing, and nothing says so; the change only guarantees that a name the service
*does* read cannot be dropped by the launcher's own bookkeeping. It does not touch `Makefile`, which is another
stream's and carries its own dev-platform target with the older ports. And it does not decide anything about
`.env`'s contents: the file is gitignored, per-machine, and now simply later in the precedence chain than the
person who typed the command.

## D55 A 401 is not an answer — the codes no request ever produced — 2026-09-24

### 1. The census

The platform emits 61 distinct error codes. Counting how many are *named* anywhere under `src/test/java` or the
`scripts/` verifiers said: **33 had never been produced by a request anyone checked.** Each of those 33 rides
behind a status some test may already assert — so the suite can be green on `401` while the client cannot tell
"your token expired" (refresh it) from "that is a refresh token" (do not) from "this session belongs to another
tenant" (sign in elsewhere). Three repairs, one status, and the code is the only one of the three that says which.

### 2. What this unit named

Eleven of the 33, each by doing the thing rather than calling a factory: a truncated token and a tampered
signature (both `invalid_token`, and the messages differ while the code deliberately does not); a token signed
with the real key and an `exp` in the past (`token_expired` — signed on purpose, because an unsigned token is
refused for the wrong reason and the test would still pass); a refresh token held up as a bearer
(`wrong_token_type`); a session minted for another tenant (`tenant_mismatch`, with the same token proved still
working at home, so the refusal is about the `tid` and not the fixture); a second registration of one address
(`email_taken`); an access token at the refresh door (`invalid_refresh_token`). Then the workspace and `/me`
family: `member_exists`, whose details are asserted to name *which role is in the way* — a 409 a screen cannot
act on is not a refusal, it is a shrug — plus `member_not_found`, `api_key_not_found`, `subject_not_found` and
`preference_not_found`, the last two checked against each other so two different absences cannot share one code.

Four mutations, all red: expiry answering the generic code; cross-tenant answering the generic code; the 409
dropping its `role` detail; the key authoriser falling back to bare `not_found`.

### 3. What is left, and where it lives

22 codes are still unnamed. Thirteen exist only in untracked files — `cart_*`, `order_*`,
`insufficient_stock`, `reservation_not_addable`, `offering_not_purchasable`, `listing_not_publishable`, one
`conflict` in the admin console — so they belong to the commerce and admin streams: reported, not walked. Nine
sit in code this lane owns behind real doors: `moderation_case_not_found`, `review_not_found`,
`conversation_not_found`, `no_open_handoff`, `notification_not_found`, `offering_not_found`, `slug_taken`,
`invalid_id_token` and `not_implemented`. Two of those nine are config-gated rather than hard to reach:
`not_implemented` fires when `NEXUS_AI_INTERNAL_TOKEN` is *unset*, which the shared harness always sets, so
witnessing it needs its own context; and the OAuth `dev` verifier raises `invalid_id_token` only for a token it
can parse at all. That is a queue with reasons attached, not a mystery.

One method note, because it nearly shipped a false statement. The first census split "this lane vs another
stream" by matching walked paths against `git ls-files`, and on Windows `os.walk` yields backslashes where
`ls-files` prints forward slashes — so it reported *zero* codes in this lane, including `subject_not_found`,
which this session had committed hours earlier. The error was in the convenient direction (nothing left to do),
and it is the same failure the project keeps meeting: a measurement that matches nothing reports success.
Normalising separators moved the number from 0 to nine.

```
AuthRefusalCodesTest   new · 7 tests · the auth family by doing, plus §1's envelope on a refusal
MerchantWorkspaceTest  13 → 14 · the three workspace absences named, and the 409's role detail
FavoriteDoorTest       5 → 6 · subject_not_found and preference_not_found, distinct from each other
mutations run          4
codes                  emitted 61 · unnamed before 33 · unnamed after 22 (13 in other streams' files, 9 queued)
suite                  178 → 187 run · the 1 red stays com.nexus.admin's
```

What this does not do. It does not assert message *text* anywhere: codes are the contract surface, prose is for
humans, and pinning wording only makes wording harder to fix. It does not add a gate that every code is named —
that would freeze a list which legitimately grows — and it does not change any ladder rung: §1's eight statuses
have all been produced by a request since D47 and D49.

```
LogoutDoorTest        new · 3 tests · cookies + family + audit, the surviving bearer, the anonymous call
SavedSearchDoorTest   new · 3 tests · save/list/remove, the defaults (notify false, intent {}), the two 404s
                      that read alike, the owner's row surviving someone else's delete, a refused save storing
                      nothing
FavoriteDoorTest      +1 test (5 now) · the favourites door's identical 404, with the same survivor check
mutations run         5 · both 404 guards reverted (2 tests red) · revoke() dropped (refresh refusal red) ·
                      cookie clearing dropped (headers red) · logout audit dropped (red) · accept() fails open
                      (the revoked family mints again)
suite                 166 → 173 · the 1 red stays com.nexus.admin's
```

What this does not do. It does not close the bearer's 900-second window, for the reason in §3 — and it no longer
lets prose imply otherwise. It does not walk the two untracked merchant doors or `ucp.json`, which are reported
with their counts rather than borrowed. It does not connect `notify` to any notification mechanism: the column
stores the caller's wish and §7 now says only that, because nothing in this build reads it — the door's remaining
half-promise, reported rather than wired. And it does not turn "is there a test naming this route?" into a gate:
a route count is the wrong thing to freeze into a build rule, because a path can be named by a test that asserts
nothing about it, so the audit stays a method run by hand.

## D56 The nine that were left, and the three that turned out to have no door — 2026-09-24

### 1. Working the queue D55 left

D55's census closed with nine codes in tracked code and "real doors", by its own count. Six now have a witness
produced by a request; three do not, and the reason they do not is the finding, not a shortfall:

- `conversation_not_found` — GET an absent thread, and the same absence through the merchant authoriser's
  `conversation:id` lookup, asserted to answer identically (D5: a 403 would confirm the thread exists).
- `no_open_handoff` — an existing assertion checked only `409`; it now names the code, because that 409 has a
  sibling on the same route (`case_already_resolved`-style collisions) and a client cannot retry what is already
  settled.
- `notification_not_found`, `moderation_case_not_found` — same upgrade: a 404 that used to be only a status.
- `invalid_id_token` — unreachable under the default test profile, because `OAuthVerifierRegistry` registers the
  dev verifier only under dev/test. `DevOauthRefusalTest` turns the profile on to produce it; and
  `AuthRefusalCodesTest` now asserts the *other* half, which is what the default profile actually does: a 422
  naming the provider and listing what is wired up. §42's finding, arriving from the opposite direction — a
  refusal that depends on configuration the shared harness never sets is a refusal no test has ever seen.
- `not_implemented` — the internal conversation door with `NEXUS_AI_INTERNAL_TOKEN` unset, which the harness
  always sets. `InternalDoorUnconfiguredTest` overrides it blank, which is also the honest way in: the guard's
  rule is "shorter than 16 characters means unconfigured", so a short token would take the 401 branch instead and
  the 501 would still never have been produced.

### 2. The three that have no door in this build

`offering_not_found` is raised through `WorkspaceAccess` only for routes scoped by `merchant = "offering:id"`,
and both such routes live in `MerchantContentController` — untracked, another stream's. `slug_taken` is raised by
`MerchantService.createBusiness`, whose only caller is that same controller. `review_not_found` sits behind a
state nothing in this build can make: a moderation case whose `subject_id` points at no review row — cases and
reviews are written together, so the branch is an internal-consistency guard, not a reachable refusal.

**Corrected by D61, in part:** `slug_taken` now has a door in this lane too — `POST /api/v1/collections` answers
it from `collections_tenant_id_slug_key`, and `CollectionDraftWriteTest.theIndexIsTheReplayGuard` is the witness.
What is not corrected is the other two: the `MerchantService` caller named above is still the only producer of that
code on a merchant row, and it is still unserved here.

That is a correction to D55 as much as a result: its "nine with real doors" was a count of files in this lane,
not of doors a test can knock on. Three of the nine were tracked code behind an untracked door or a state no door
creates, and the census cannot tell those apart — only reading the caller does.

```
new                 ConversationApiTest +1 method, AuthRefusalCodesTest +1, ModerationFlowTest +1,
                    NotificationApiTest, InternalDoorUnconfiguredTest (new class), DevOauthRefusalTest (new class)
mutations run       4 · no_open_handoff → generic conflict · moderation_case_not_found → bare not_found ·
                      configured() always true (the 501 becomes a 401, which is the ordering proved) ·
                      notification_not_found → bare not_found
codes               unnamed in this lane: 9 → 3, all three reported with the reason they are unreachable
```

Two process notes, both about this unit's own writing. The entry above was nearly wrong twice: once by
trusting D55's file-based count as a door-based one, and once because the first version of these docs inserted
this section's predecessor in the middle of the sequence, leaving the file ordered D51, D55, D52 — caught by
reading `grep -n '^## D5'` rather than by any gate, which is a reminder that the ordering rule in this file is
also an unwritten promise.

### 4. And a budget the suite had been spending without saying

Between the first green run of this unit and the second, the full suite came back with **seven errors** — not
assertion failures — with `FATAL: remaining connection slots are reserved for roles with the SUPERUSER
attribute`. The cause was this unit's own shape: `InternalDoorUnconfiguredTest` and `DevOauthRefusalTest` each
override properties, so each gets its own cached Spring context, and each context keeps its own Hikari pool at
the base file's `maximum-pool-size: 20`. Contexts cost connections. Nothing in the tree said that, so the suite
had been growing toward the container's limit one witness class at a time, and the first failure was mine.

Fixed where it belongs — `NexusIntegrationTest` now pins five connections per context, with the reason in its
comment — rather than by raising `max_connections` on a Postgres container that other streams and other runs
share. That leaves the suite at 192 tests, one red, and the red is `com.nexus.admin`'s. What it does not leave is
a guard: nothing stops a future class from being the twenty-fifth context, and the honest statement of this
section is that the ceiling is now further away, not gone.

## D57 Counting the thing D56 said was not gone — 2026-09-24

### 1. The promise, then the gate

D56 ended with a sentence that was true and useless: the connection ceiling "is now further away, not gone, and
nothing yet counts the contexts." This unit counts them.

`TestConnectionBudgetTest` asks the container what its limit is — `select current_setting('max_connections')`,
currently **100** — counts the test classes that will each take a cached Spring context of their own (anything
carrying `@TestPropertySource`, `@ActiveProfiles`, `@MockitoBean` or `@MockBean`: **eight** today), reads the
pool size the running service actually bound (**5**, the harness pin from D56), and asserts the arithmetic that
follows: `pool ≤ (max − 1) / contexts`, which today allows 12 per context and leaves the suite at 40 of 100. The
gate itself adds no context: it overrides nothing, so it joins the shared one, which is the whole etiquette the
measurement is about.

### 2. Why the shape, and where it is soft

The ceiling is read rather than written down because it is not this repository's fact to keep: it belongs to a
container another stream may resize, and a remembered "100" would age into a wrong constant the same way the
deadline column in D46 did. The pool is read from the live `Environment` rather than trusted from the harness for
the same reason — the file that sets it and the test that checks it are not allowed to drift apart silently, which
is D44's failure with the roles reversed.

Two assertions, deliberately ordered: the derived allowance first, so a raised pool fails for the reason that
matters, and the pin second, so lowering the pin in one place without the other fails too. The first has a
witness that bites (pool 13 → "no context may hold more than 12"); the second's is the same file with the value
changed to 4, which passes the budget and fails the tie.

Where it is soft, stated plainly rather than hidden in a caveat: the count is an upper bound on *distinct*
context keys, because two classes overriding identical properties share one — so it will over-count before it
under-counts, which is the safe direction for a ceiling. A `@SpringBootTest` class that does not extend the shared
harness would be missed entirely; none exists today, and the list of counted classes is printed in the failure
message so a future miss is at least visible. And a class that *removes* its property overrides would lower the
count by merging into the shared context, which is not a failure but a real saving, so the gate lets it through.

What the number is actually for: not to forbid new witness classes — D50 through D56 added six of them, each
because a promise had no proof — but to make the cost of one visible at the moment it is added, next to the
headroom that remains. A budget nobody reads is spent until something fails, and the way it failed in D56 was
seven errors in somebody else's run.

```
TestConnectionBudgetTest   new · 1 test · ceiling from the container, pool from the Environment, classes from source
measured                   contexts 8 · max_connections 100 · pool 5 · allowance 12 each · worst case 40 of 100
mutations run              2 · pool raised to 13 (allowance red, with the arithmetic in the message) ·
                           pool lowered to 4 (pin red, budget satisfied)
suite                      192 → 193 run · the 1 red stays com.nexus.admin's
```

## D58 A favourite is a link, and the seed ships the links — 2026-09-24

### 1. What D50 left half-done

D50 closed a write door: `POST /api/v1/me/favorites` no longer accepts a collection the §8 readers would hide.
It did nothing about the rows already in the demo data, and the seed is older than that door — 18 favourites,
loaded by the generator, never re-checked against what the screens will actually render. So the same defect D35
found from the other side (a rating displayed with no fact behind it) was live here as a *bookmark that clicks
into a 404*, and only the write path had been fixed.

Measured first, before writing anything: all 18 seeded favourites point at rows a reader can show — 12 published
merchants, 4 active offerings, 2 collections that clear §8's own `visibility='public' AND published_at IS NOT
NULL` plus attribution gate. No bug in the data as it stands today. Which is exactly why it belongs in
`quality.sql`: a pairing nobody asserts is a pairing that decays, and the generator is edited more often than the
gate is read.

### 2. The two checks, and the vocabulary one with them

`favourites point at a renderable row` re-derives each row's target through the same predicates the readers use —
merchant published, offering active, collection publishable including the author-or-provenance branch — and names
the count in its detail, with `count(favorites) > 0` required so an empty table can never satisfy it (D44's
non-zero guard, because a check over nothing is a pass that means nothing).

`favourite subject_type is one the API can save` is the quieter half of the same finding: `FavoriteBody`'s pattern
accepts `merchant|offering|guide|collection`, and a seeded row outside that set would load cleanly and then be
re-creatable by nobody — data the write path does not know about, the D49 species arriving through the seed
instead of the filter.

`scripts/db_gate_fresh.sh`: 168 checks → **170, PASS** on a from-scratch schema and a freshly generated dataset.
Both were then falsified rather than assumed, inside a transaction that was rolled back: a favourite aimed at a
non-existent merchant makes the renderable predicate report 7 bad rows, and a `subject_type='voucher'` row makes
the vocabulary predicate report 1 — with the residue query confirming afterwards that the shared `nexus_test`
kept neither.

What this does not do. It does not make the seed's favourites *saveable-through-the-API-by-construction* — the
generator writes rows directly, and the same asymmetry exists for any table it loads; these two checks are the
guard, not a rewrite of how the seed is produced. It does not add a `CHECK` or FK on `favorites.subject_type`
(that is V1 schema, infra-owned, and a migration is a shared-state decision, reported rather than taken). And it
leaves the standing reports where §48 and §52 put them.

## D59 A documented command that only worked for the one caller who hid it — 2026-09-24

### 1. What broke, and why nothing saw it

`scripts/run_platform_dev.sh` is `set -euo pipefail`, and its `--log` branch expanded `$ROOT` where the script
defines `root` (lowercase, sixteen lines earlier). With `set -u` that is fatal, so the command the script's own
usage comment tells a person to type — `scripts/run_platform_dev.sh --log` — died with `ROOT: unbound variable`
before starting anything. It is in `HEAD` as it stands, not damage from D54's rewrite of the block above it.

Nothing caught it because the only automated caller is `e2e_fresh.sh`, which exports `NEXUS_DEV_LOG` and
`NEXUS_DEV_PID` — so the `$ROOT` half of `${NEXUS_DEV_LOG:-$ROOT/.platform-dev.log}` was never evaluated in any
run anyone ever scripted. The bug lived precisely in the path the tests take for granted: the human's. Found
because D59 went to look at the live demo through the documented route instead of trusting the gate that had
already booted it a dozen times.

### 2. The fix, and the witness that keeps it

`$root`, and `scripts/check_launcher_log_mode.sh`: run the real script with `mvn` stubbed and both overrides
*absent*, which is the human path, and assert it reports a background start rather than a shell error. The
witness is proven in both directions — reintroduce `$ROOT` and it fails with the exact line and message; leave
the fix in and it passes. That matters more than the one-line edit: the script is how every session on this
machine starts the service, and a broken default path is a broken onboarding path that no Java test can see.

It is now step 0 of `e2e_fresh.sh`, which is the gate that depends on the launcher and the file that always set
those variables — the automated caller checking the manual one.

One side effect had to be designed out, because using the defaults *is* the test: those default paths are the
files a running instance appends to. So the smoke saves the log and pid file first and puts them back on every
exit path — or removes them if they were absent — verified with a sentinel line rather than asserted. A
verification that truncates a live session's log to prove a point costs more than the point is worth, and the
first version of this script did exactly that before it was reviewed.

### 3. What the live boot showed

With the path fixed, the demo instance came up on :8090 against the seeded `nexus` database (520 merchants,
11,000 reviews, 18 favourites, 4 collections, 60 tables — in the *5433* container; the other Postgres container
on this host has an unrelated `nexus` database with none of these tables, which is worth knowing before anyone
points a verifier at the wrong one). Read slice, real data, no fixtures: directory cards with Chinese titles;
`GET /api/v1/collections` and `GET /api/v1/guides/sha-tin-date-night` → 200; `/.well-known/ucp` → the honest
`not_integrated` payload with empty capabilities; a seeded merchant's `/ucp.json` → 404
`ucp_profile_not_published`, which is D52's "no publisher exists" seen on the running service rather than in a
test; the demo consumer's favourites → the seeded merchant and offering rows, through the door D50 and D51
hardened; `/me/saved-searches` → `[]`. Then the instance was stopped and :8090 returned to not listening, the
state before this unit.

```
launcher              $ROOT → $root at run_platform_dev.sh:86-87 (pre-existing, confirmed against HEAD)
new witness           scripts/check_launcher_log_mode.sh · red with the bug restored, green with the fix
e2e                   one more step (0/10, the launcher smoke); step 10's rate-limit rung and ledger unchanged
live verification     :8090 against the demo DB: reads above, then stopped; the demo login wrote its usual rows
```

What this does not do. It does not wire the smoke into CI — `.github/workflows/ci.yml` is dirty with another
stream's work, so the gate it now belongs to is the e2e, and widening CI is theirs to do. It does not complete
task #9's browser leg either: the read slice above is HTTP against live data, not a rendered page, and the web
app is still another stream's dirty tree. And it does not reconcile the two `nexus` databases on this host —
which container is authoritative is documented in `STATUS.md` §54 rather than changed here.

## D61 The write that needed a decision, and the half that did not — 2026-09-25

### 1. What was actually blocked

Task #34 carried §8's two writes as "needs a design decision first", and for one of them that was true. Measured
rather than argued: `collections` has `tenant_id`, `author_id` and **no merchant column** (V1's own DDL, re-read
before writing this), so there is no `@RequiresPermission` that could guard a row the schema cannot attribute to a
business — the workspace chain guards merchant-scoped rows and this table is not one. §27 reserves publication for
a human decision. So the open question is which authority owns a published guide — platform, author, or a merchant
once the table can name one — and inventing a permission string to satisfy an interceptor would have been
inventing product semantics, which is not mine to do.

What the block conflated was **create** and **publish**. A row that no read serves settles none of those
questions: it is not a ranking input (§66/§67's organic order takes no placement input), not a claim shown to a
stranger, not demo content (§109), and not a publication (§27). It is a person's own text in a private state — the
one state a §8 write can occupy without anybody having agreed on ownership first. So this unit ships that half and
leaves the other open, with the line between them now enforced by code rather than by a comment.

### 2. What landed

`CollectionsWriteController` — `POST /api/v1/collections`, `@RequiresAuth`, `201` — and three rules whose teeth are
named:

- **The trust-bearing columns are literals in the `INSERT`, not body fields.** `author_id` is the session's
  subject; `visibility='private'`, `published_at` null, `data_origin='user'`, `seo='{}'`, `tenant_id` the
  request's tenant. Provenance, publication and the demo badge are all things that *happened* to this row rather
  than things its author declared. A body sending any of those six gets `422` naming the reason for that key; any
  key the route does not read gets the same refusal with the accepted list, because a silently-dropped field is
  how `titel` comes back as "the API lost my title".
- **Publication is not routed.** No verb in this build stamps `published_at`, so §27 holds by construction. That
  sentence used to be prose in `API_CONTRACT`; it is now a question put to the running
  `RequestMappingHandlerMapping`, which enumerates every `(method, path)` under `/api/v1/collections*` and
  `/api/v1/guides*` and refuses anything beyond the four reads plus this create — compared for equality, because a
  handler with no declared verbs answers every verb, which is exactly how a publish would sneak in.
- **Replay is settled by the index.** `collections_tenant_id_slug_key` (V1's `UNIQUE (tenant_id, slug)`) makes a
  retried slug one row and a `409 slug_taken` naming the id, kind, visibility, publication state and ownership of
  the row it hit. That is D45's choice for a retried reservation, and the reason this route demands no
  `Idempotency-Key`: a stored answer would be a second record of a fact the constraint already guarantees.

Two reuse decisions, both D44's "ask the owner, don't copy the predicate": `kind` is checked against
`CollectionsController.KINDS`, the same list the directory filters `?kind=` with, so a kind nobody can read cannot
be created; and the response is that controller's own `summary()`/`authorOf()` projection of the stored row plus
the fields only a write can state (`status`, `status_note`, `authorisation_basis`, `publish_requires`, `replay`,
`as_of`), so the author sees the draft exactly as a directory will see it once published — including the parts that
are still null. `items` is stored as written after shape validation, and a typed `{type,text}` block passes through
untouched, because §8's read is what resolves ids and already names the ones it could not on `dropped_item_ids`.

### 3. The mutation run, and the three corners it caught

Nine ways to break a promise, each applied to the real source, each reverted. These are the verdicts of the pass
run against the repaired class; the pass before it differs in two rows, and that difference is the section below.

```
M1 SCOPE loses `published_at is not null`             RED 1/6 — aDraftIsNotAPublication
M2 SCOPE loses `visibility = 'public'`                RED 1/6 — aDraftIsNotAPublication
M3 the INSERT writes 'public' instead of 'private'    RED 3/6 — aDraftIsNotAPublication, authAndTenantAreBothLoadBearing,
                                                          theIndexIsTheReplayGuard
M4 refuseUnsettable() never called                    RED 1/6 — theTrustBearingColumnsAreNotBodyFields
M5 the INSERT badges a person's draft 'demo'          RED 2/6 — aDraftIsNotAPublication, authAndTenantAreBothLoadBearing
M6 a @PatchMapping(/collections/{slug}) lands on the create handler
                                                      RED 6/6 — every method in the class
M7 @RequiresAuth deleted from the route               RED 1/6 — authAndTenantAreBothLoadBearing   (green on the two passes before)
M8 the cover_url scheme check switched off            RED 1/6 — refusalsAreSpecific
M9 the 409 always claims the row is the caller's      RED 1/6 — theIndexIsTheReplayGuard
```

Three of those nine had to be earned, because the class that was supposed to catch them was itself broken three
different ways, and each breakage was invisible in a different manner.

**M2, green on pass 2: an AND tested on one corner is half an AND.** §8's publishability is
`visibility='public' AND published_at IS NOT NULL`, and the original walk went created → flip `visibility` alone →
stamp `published_at`. Every state it visited had `published_at IS NULL` or both facts true, so deleting the
visibility half of `SCOPE` — for the directory, the by-slug page, `/guides`, and the favourites door — changed
nothing observable and the class stayed green. The walk now covers all four corners on the row it created: neither
(hidden), dated but still private (hidden, and the favourites door says so too), public-flagged but never dated
(hidden), both (served). That third state is what M2 needed to find anything.

**M7, green on pass 2: a 401 with two independent causes.** Deleting `@RequiresAuth` left the anonymous call
answering `401 unauthorized` and writing no row, because `Req.userId` throws the same code with the same message
one line later inside the handler. The HTTP leg witnesses the outcome; it cannot witness which half refused. So
the test should also ask the method — the one mapped `POST` in that class must declare `@RequiresAuth` — which is
the same two-halved claim `IdempotencyPairingTest` makes about `@Idempotent` and `IdempotencyService.run`: a door
that happens to be shut is not a door.

**M7, green again on pass 3: an assertion object is not an assertion.** The fix above was written as
`assertThat(method.isAnnotationPresent(RequiresAuth.class)).as("%s is §8's only write…", name)` inside a stream
`peek`, terminated by `.count()`. That compiles, reads like a gate, and decides *nothing* — `assertThat` returns an
object and `as` returns the same object with a nicer message attached; only the calls further down a chain
(`isTrue`, `isEqualTo`, `hasSize`) assert anything. Pass 3 therefore reproduced pass 2's green, and the difference
between "the gate holds" and "there is no gate" was visible as nothing at all. The check now collects the mapped
methods, asserts the list's size, and calls `.isTrue()` on each element in a loop. A mutation that survives two
passes is not evidence about the source; it is evidence about the test — and on the second pass that was the only
thing it was evidence about.

**M9 is the same finding applied before it had to be caught.** `owned_by_caller` has two values, and the original
class visited only one: the retry against the caller's own row. Hard-coding the field to `true` therefore passed
every assertion that touched it. The test now clashes with a draft written by a *second* account in the same
tenant, and asserts the false branch, the id it names, the visibility it names, and that the clash wrote nothing.
In the seeded demo tenant this is the ordinary case rather than the edge one — `select visibility, data_origin,
count(*) from collections group by 1,2` there is four rows, all `public`/`demo`, so anyone typing one of those four
slugs is clashing with a row they do not own.

Because "a chain that never reaches a terminal assertion" is a *shape* rather than a typo, the whole test tree was
swept for it: every `assertThat(` / `assertThatThrownBy(` / `assertThatCode(` / `assertThatExceptionOfType(` in
all 40 files under `src/test/java`, flagged when its following chain contains no call other than
`as`/`describedAs`/`withFailMessage`. The result is zero beyond the one already repaired — which counts for
something only because the sweeper was falsified first on a planted file, where it named all four vacuous cases
(including `assertThat(map.get("k)"))`, whose string holds an unmatched bracket) and left the two real assertions
alone. It is a reading aid, not a gate: it cannot see a chain that ends in a *wrong* terminal, and it does not
pretend to. Turning it into one is D62's job.

M6 is worth reading carefully, because it failed harder than designed. Adding a second mapping annotation to the
create handler does not add a verb to the route: Spring refuses the pair, `POST /api/v1/collections` stops being
mapped at all, and the six tests fall down together — the 405 form of "a publish sneaked in" is also the form of
"the create disappeared", and only the router-set assertion tells those two apart.

### 4. Corrections this forces in the docs

- `API_CONTRACT` §8's "`POST /api/v1/collections` is not served" is now false and reads *served, and what it serves
  is a draft*; the reason the route was held open stays printed, because it is exactly true of publication.
- §1's list of writes whose replay lives in an index: this unit's first patch rewrote that sentence's opening
  numeral ("Two" → "Three") and then named two, which is the defect I report in other people's prose. The numeral
  is gone — the sentence now says "writes outside that list", the one thing this unit can vouch for. Two separate
  reasons not to restate a count there: the census belongs to `IdempotencyPairingTest`, and another stream's
  commerce routes are sitting in a dirty tree right now, so any number written this morning would be a number about
  a build that does not exist yet.
- D56 §2 said `slug_taken` "has no door in this build". It has one now, and it is in this lane.

```
new                 CollectionsWriteController · CollectionsRepository +insertDraft/anyRowById/anyRowBySlug
                    CollectionDraftWriteTest (6 methods)
changed             CollectionsController: KINDS / summary() / authorOf() opened to package use, no behaviour edit
witnesses           the §8 invariant in four states · the router asked, not the prose · 6 reserved keys + a typo
                    · 10 refusals that write nothing · the 409 that names the row it hit · per-tenant slugs
mutations run       9, all red on the pass after the repairs. Before the repairs: M2 green (one corner of an AND
                    unvisited), M7 green twice — the second time because the fix's AssertJ chain ended at `.as(…)`
                    with no terminal call, i.e. it asserted nothing
```

What this does not do. It does not decide who publishes a guide, and it does not ship the verb that would: the row
becomes readable by a stranger through SQL a publisher runs, which is the honest shape of "a human decides" while
the authority question is open. It does not resolve `items` at write time — a draft citing an unpublished shop is an
honest draft, and §8's read names what it cannot resolve. It does not touch `POST /api/v1/share`, the other half of
task #34: that one was settled by another stream, in a `V7__share_links.sql` and a `com.nexus.growth.ShareController`
that are still untracked in this working tree as of this writing, so their verdict is their own commit's to make.
And it notes, without fixing, that `collections` is one of six tables carrying an `updated_at` column with no
`*_updated_at` trigger (measured against the live schema: `business_hours`, `availability_slots`, `reviews`,
`collections`, `user_preferences`, `review_summaries`) — the two writers that exist today set the column by hand in
their `UPDATE`, so nothing lies right now, and nothing guards the writer that forgets. A migration is shared state,
so it is reported rather than taken.


## D60 Nobody had ever asked who was signed in — 2026-09-24

### 1. The seam that fell between two gates

`verify_served_reads.mjs` checks 525 public reads against the throwaway seeded database, and the Java suite checks the authenticated `/api/v1/me/**` doors against tenants each test builds for itself. Between them, no automated run had ever asked the question a user would notice first: does the **seeded account's own saved list** survive the trip from `data/seed` through the API to a caller with a token? D58 had just asserted in `quality.sql` that every seeded favourite points at a renderable row — an invariant about data. Nothing asserted it about the door.

`scripts/verify_seed_surface.py` does, inside `e2e_fresh.sh` step 7 where the throwaway database is this script's own: the favourites door answers 401 without a token; the demo login reaches `demo.consumer@example.hk` (the one account that owns all 18 seeded favourites — measured before writing the check, because a demo login to an empty inbox would have been a green nothing); `GET /me/favorites` returns 18 rows each with a `subject_type`, a uuid `subject_id` and a `created_at`, 15 of them carrying their seeded note text; the two saved collections resolve through the public list to their slugs and open at 200; four saved merchants open on their public pages; and `/me/saved-searches` answers `[]` because the seed stores none, which is stated rather than skipped.

### 2. What it deliberately does not claim

Offering favourites are counted and typed, not dereferenced: an offering has no public by-id page — it is reachable through its merchant, which the favourites row does not carry — so resolving four ids would mean walking 520 merchant pages to find them, and the check would be a benchmark, not an assertion. That gap is the same one §8's missing `GET /api/v1/offering/{id}` raises generally, reported rather than papered over.

The check refuses to pass on an empty list (`len(favs) > 0`) and the step `die`s if the script exits non-zero, so neither a seed that stops shipping favourites nor a login that starts returning nothing can slide through as a pass. Its own failure path was exercised the same session: pointed at a tenant with no demo account it reports two failures and exits 1, which is what makes the fifteen passes mean something.

```
new                 scripts/verify_seed_surface.py (15 checks), wired as part of e2e step 7
measured first      one seeded user owns all 18 favourites: demo.consumer@example.hk; 2 collections, 12 merchants, 4 offerings
proofs              positive against :8090 on the demo DB · negative against an unknown tenant (rc=1, two failures)
e2e                 PASS end to end with the new step: 525 reads, three walks, 15 signed-in checks, rung, ledger
```

## D62 An assertion that decides nothing, and the gate that refuses it — 2026-09-25

### 1. The lesson D61 recorded is not about that route

D61's mutation table carries `M7 … (green on the two passes before)` and a paragraph explaining it. That paragraph
describes a shape that cannot be fixed by remembering it, so it is repeated here in its own words and then made
unenforceable-by-accident rather than unmissable-by-care.

`assertThat(x)` hands back an `AbstractAssert` object. `.as("…")` hands back **the same object** with a nicer
failure message attached. `isTrue()`, `isEqualTo(…)`, `hasSize(…)` are the calls that decide something. So the
statement

    assertThat(method.isAnnotationPresent(RequiresAuth.class)).as("%s declares its own door", name);

inside a stream `peek` is not a weak assertion — it is not an assertion. It builds an object, describes it,
discards it. It is green under every possible source, including the one where the annotation is gone, and it is
typographically indistinguishable from the check it replaced. Two mutation passes passed before anyone read the
line instead of the run.

### 2. The shape is now refused across the module

`AssertionChainShapeTest` is a plain JUnit class: it opens no context, so `TestConnectionBudgetTest`'s arithmetic
is untouched (that gate skips any class naming neither `NexusIntegrationTest` nor `@SpringBootTest` — re-read
before claiming it, D56's ceiling is easy to spend by accident). It walks `src/test/java` off disk in the house
pattern of `IdempotencyPairingTest`, so the input is the tree rather than a list of files someone remembered.
Measured over the tree as it stands: **41 test files, 1,505 `assertThat*(` entry points read, 0 chains that stop
at a describer** — including the untracked packages this lane does not own.

Three parts of the reader each had a defect in the first draft, which is why they are written down:

- **Comment and literal bodies are blanked, never removed.** Positions, newlines and the delimiters themselves
  survive, because `lineOf()` reports the line the developer sees and because a `)` inside `"a ) in a string"` is
  not the end of an expression. A chain living in a `//` note is not a chain, and the gate must not ask anybody to
  delete a comment.
- **A qualifier decides whose method it is.** `Assertions.assertThat(x)` is ours; `helper.assertThat(x)` is
  somebody else's and its contract is not this gate's business. The identifier before the dot is read, not
  guessed from the method name.
- **The describer set is closed and named:** `as`, `describedAs`, `withFailMessage`, `because`, `over`. Everything
  else a chain calls is treated as a decision, including calls this file has never heard of. The rule errs toward
  silence, which is the failure mode a mutation run can find; the other direction — inventing terminals — would
  fail the tree walk on the next honest test anyone writes.

### 3. "Found nothing" and "read nothing" print the same thing

An empty list is the gate's passing output and its broken output, so two guards make the emptiness mean
something:

- **The census.** `assertThat(entries).isGreaterThan(1000)` runs before the verdict, where `entries` is what the
  reader counted as it walked. The real number is 1,505, so the floor sits at two thirds of the tree: a narrowed
  entry list, a failed walk or an over-aggressive mask goes red on the count before it can go green on the result.
- **The planted cases.** `readerSeesWhatItClaims()` hands the reader ten fixtures and requires the exact verdict on
  each. Four shapes must be flagged: a chain ending at `as`, a bare `assertThat(x)` with no chain at all, a chain
  whose string literal holds a `)` and which ends at `describedAs`, and an `assertThatThrownBy(…).because(…)` with
  no verdict. Six must not: the second case's own chain with `isTrue()` appended, an `Assertions.`-qualified chain
  that decides with `containsExactly`, `helper.assertThat(…)` as somebody else's method, a chain inside a `//`
  note, a `satisfies(…)` whose inner chain decides, and a text block full of unbalanced brackets. The reader is
  therefore only trusted on the tree because it was tested against cases where it is known to be right or wrong —
  the same reason a `WHERE` clause is verified by asking for rows that must not come back.

### 4. Four ways to break the new gate, and the verdict each time

| Mutation | Verdict |
| --- | --- |
| **M-a** — plant `assertThat(slug).as("planted for the mutation run");` in `CollectionDraftWriteTest:182` | **RED** 1/2 — `noTestStopsShortOfADecision`, reporting `CollectionDraftWriteTest.java:182: chain=[as]` |
| **M-b** — drop `assertThat(` from the entry list, leaving only the three exception entry points | **RED** 2/2 — census reads `Expecting actual: 8 to be greater than: 1000` (1,505 entry points become 8), then the planted-case test |
| **M-c** — `mask()` erases the whole file instead of blanking bodies (`new char[len]`) | **RED** 2/2 — same two guards |
| **M-d** — declare `isEqualTo` a describer, i.e. over-report | **RED** 2/2 — planted cases first (`Expecting empty but was: ["2: chain=[isEqualTo]"]`), then 361 distinct real chains named |

Each mutation was reverted from a byte-for-byte backup taken before the run and the gate re-verified green
afterwards (`Tests run: 2, Failures: 0`). M-b and M-c are the two that matter most: they are the mutations where a
gate would otherwise be **green forever and say nothing about itself**, and both die on the census rather than on
the emptiness of its result list.

Full suite after the change: `Tests run: 214, Failures: 7` — all seven in
`com.nexus.commerce.CommerceApiTest`, an untracked package this lane does not own and the same seven D61 reported;
the two methods of the new gate ran green inside that run.

### 5. What D62 does not claim

- A chain can reach a terminal and pick the wrong one: `isTrue()` on the wrong boolean, `isEqualTo()` against a
  value the test computes from the same source it is checking. This gate reads shape, and shape is not meaning —
  that difference is what a mutation run is for, which is why D61's table exists.
- A describer this file has never seen is treated as a decision, so `assertThat(x).someNewDecorator()` passes. The
  closed list in §2 is the known soft edge; adding to it is a deliberate act, and the census keeps anybody who
  edits it honest about how much of the tree the reader still covers.
- The walk is `services/platform/src/test/java`, which is where this lane's tests live. `apps/web`, `apps/ai` and
  `packages/*` have their own gates and their own assertion libraries; nothing here claims their shape is sound.

## D63 A truncate list that cannot know the schema — 2026-09-25

### 1. What broke, in the words the failure used

Every fresh-database gate went red tree-wide on the same three lines, before any of them could run a check:

```
ERROR:  cannot truncate a table referenced in a foreign key constraint
DETAIL:  Table "share_links" references "users".
HINT:  Truncate table "share_links" at the same time, or use TRUNCATE ... CASCADE.
```

`share_links` is V7's table — another stream's migration, still untracked — and it held **zero rows** in the demo
database (`520` merchants, `5534` offerings, `11000` reviews, `0` share links). So the reset that died was one that
would have destroyed nothing: Postgres refuses to truncate a parent while *any* foreign key points at it, empty or
not, and `out/00_truncate.sql` was a hand-written list of 22 table names with no way to learn about a migration
written after it.

### 2. Both obvious answers were wrong

- **Add `share_links` to the list.** The list is `generate.py`'s claim about the tables *it* seeds. Putting another
  stream's table in it means V8 reproduces the same death, and it makes a generator responsible for resetting rows
  it never writes.
- **`TRUNCATE ... CASCADE`.** One word, permanently green, and the loudest way this file could silently empty
  tables nobody listed — orders, carts, conversations, whoever's rows they are. The seed has always kept a line
  between "demo data" and "data the platform wrote" (§109/§110: no fake orders, no fake traffic). CASCADE deletes
  the line.

So the decision is not in the list at all. It moves to load time, where the schema is available to be asked.

### 3. The rule that replaced it

`emit_truncate()` now writes one guard that decides per table, in this order:

- **anchor** — the tables the generator owns: 22 in plain mode (`DEMO_TABLES` minus the shared `tenants` row), 49
  with `RESEED_DEPENDENTS=1` (that plus `DEPENDENT_TABLES`);
- **closure** — the anchor plus every table that refers to it, at any depth, read from `pg_constraint` with
  `WITH RECURSIVE … UNION`. `UNION`, not `UNION ALL`, so an FK cycle terminates instead of walking forever;
- **permission = emptiness** — a closure member inside the anchor is cleared; one outside it is cleared *only*
  while `count(*) = 0`. A non-empty stranger raises with its name and its row count and a hint naming the
  operator's way out. `load.sh` pipes the file under `--single-transaction`, so a refusal costs nothing: the
  database it refuses is the database it found.
- **an empty anchor is an error, not a success** — if none of the named tables exist yet the guard says "apply
  `infra/db/migrations/V*.sql` before loading the seed", because the same empty result means two different things.
- **the arithmetic is printed** — `seed truncate: 49 table(s) cleared -- 22 named by generate.py, 27 found by the
  schema's own foreign keys`. The split is the reviewable part; a bare "cleared 49" hides who decided.

### 4. What the catalog said when it was asked, on a from-scratch schema

```
plain anchor    22 named  ->  closure 47   25 strangers: 24 of DEPENDENT_TABLES + share_links
wide anchor     49 named  ->  closure 50    1 stranger:  share_links
schema          58 tables in public, migrations=7
```

Three findings in that, none of them guesses:

- **The lists agree where both speak.** 24 of the 27 tables a human had named as "points into the demo data" are
  reachable by foreign key from the demo tables, and the closure's only *extra* is `share_links` — the table the
  human list could not have known. The closure did not contradict the hand list; it caught up with it.
- **It disagrees usefully.** `events`, `agent_runs` and `llm_calls` are *not* reachable from the plain anchor: they
  hang off `tenants`, which plain mode excludes on purpose. Those three are cleared only under
  `RESEED_DEPENDENTS=1` — which is the honest reading of "wider reset", not a hole in the closure.
- **Plain mode's reach went from 22 to 47**, so a *fresh* database no longer needs the flag at all. Its job
  changed from "know the blast radius" to "permit the blast radius", which is what step 4 of `db_gate_fresh.sh`
  had been guessing at when it justified `RESEED_DEPENDENTS=1` by saying the schema might have grown.

### 5. Falsification: both branches planted, each observed to fail

A run that only ever succeeds proves neither of its claims, so `scripts/seed_truncate_probe.sh` builds a throwaway
database, loads the real seed, plants one child of `merchants` of each kind, and puts the same file `load.sh` puts
to work:

| | |
| --- | --- |
| **step 3** | the truncate must **refuse** while `probe_row_child` holds a row — `ERROR: seed truncate refused: a table outside generate.py's list refers to the demo data and is not empty: public.probe_row_child (1 row(s) written elsewhere)`, `HINT: Re-run data/seed/load.sh with RESEED_DEPENDENTS=1 …` — and leave `merchants` at 520 rows and the planted row at 1 |
| **step 4** | with the planted row deleted, the same script must **clear** both strangers: `merchants` 0, `probe_empty_child` 0, `share_links` 0 |

Two mutations of `emit_truncate()` — each applied to the generator, rebuilt into `out/00_truncate.sql` (a diff of
one line, checked), and reverted from a byte-for-byte backup with `md5sum` re-verified:

| Mutation | Verdict |
| --- | --- |
| **M1′** — `IF blockers <> ''` → `IF false AND blockers <> ''`: refusal dead, closure kept | **RED** step 3 — `the truncate SUCCEEDED with rows in probe_row_child — it cleared a table nobody listed`, printed beside `49 table(s) cleared -- 22 named by generate.py, 27 found by the schema's own foreign keys`. That is `CASCADE` wearing a generator's clothes, and the only thing standing between it and a silent data loss was a line nobody had ever seen fail. |
| **M2′** — closure arm `WHERE fk.contype = 'f'` → `… AND false`: list kept, closure dead | **RED** step 3 — `cannot truncate a table referenced in a foreign key constraint / DETAIL: Table "reservations" references "availability_slots"`, i.e. the 22-name list cannot even truncate **its own** tables. |

M2′ is the more instructive failure: same sentence shape as the original bug, different table — `reservations`,
named by the wide list and not by the plain one. So plain-mode loading had always depended on
`RESEED_DEPENDENTS=1` for a reason nobody had written down, and the reason was not "the schema might have grown"
but "the demo tables reference each other".

After each revert the probe ran green again (`RESULT: PASS — the empty child is cleared, the child with rows
refuses by name, and the refusal costs nothing`, exit 0). Integrated: `db_gate_fresh.sh` is 6/6 with **172** quality
checks against a from-scratch schema (tables=58, migrations=7) and the probe as its last step, and `e2e_fresh.sh`
passes **526** served reads plus the reservation, review, workspace, rate-limit and contract walks against the same
generated artifact.

### 6. What D63 does not claim

- **The closure sees foreign keys and nothing else.** Measured: 11 columns in this schema are named as references
  and carry no constraint — `favorites.subject_id`, `facts.subject_id`, `share_links.subject_id`,
  `audit_logs.subject_id/merchant_id`, `agent_runs.merchant_id/user_id`, `events.subject_id`,
  `feedback_events.subject_id`, `moderation_cases.subject_id`, `permission_grants.subject_id`. Polymorphic
  `subject_type`/`subject_id` pairs cannot have an FK, and `pg_constraint` cannot read the intent behind them.
  A table reachable only that way survives a reset holding rows, invisibly.
- **`audit_logs` is in neither list and reached by neither anchor** (it points at `tenants` and at actors), so rows
  a verification run wrote there outlive a reseed in both modes. For an audit trail that is plausibly correct.
  Nothing here decides it, so the table is reported rather than quietly added to a list.
- **The loader now refuses where it used to succeed by accident.** `nexus_test` carries 20 rows in `share_links`,
  so a plain `load.sh` into that database stops with `public.share_links (20 row(s) written elsewhere)`. That
  message is the feature; the previous behaviour was to fail earlier, on a different table, with no hint.
- Whether a stranger's rows *should* be discarded is a product question. This change turns it into a named,
  countable one; it does not answer it.

## D64 A check that can only pass in one direction — 2026-09-25

### 1. Four names against twenty-nine

`data/seed/quality.sql` has always had two ways of answering "is this dataset honest?". Part B sweeps
referential integrity *from the catalogue*: every declared foreign key in the demo graph is discovered at run
time, so a migration nobody has read yet is checked the day it lands. And then there was the §109/§110 row:

```sql
('no seeded orders/reservations', (SELECT (SELECT count(*) FROM public.orders) +
  (SELECT count(*) FROM public.reservations) + (SELECT count(*) FROM public.events) +
  (SELECT count(*) FROM public.feedback_events)) = 0, '…');
```

Four tables, spelled by hand. The asymmetry is the whole defect: one half of the same file learns the schema
and the other half remembers it. V7 is the case in point — `share_links` is reached from `users`, holds 20 rows
in the test database, and is named nowhere in this file, so a fabricated link would have passed a check whose
sentence claims to forbid exactly that.

### 2. And a third copy of the same answer

Measured before anything was written, three places in this lane answered the question "which tables does the
seed own?":

```
part A (row counts)      23 names   == generate.py's DEMO_TABLES
part B (FK sweep)        22 names   missing `moderation_cases`
generate.py DEMO_TABLES  23 names
```

The missing name cost nothing today: no table in V1–V7 references `moderation_cases`, so the sweep had no row
to lose. That is precisely the shape of the problem — a drift like that is invisible until the migration that
makes it visible arrives, and the file keeps printing "every FK in the demo graph" while quietly narrowing the
graph. `seed_anchor` is now the file's single answer, and parts A and B and the traffic sweep all read it.

### 3. The pair of rows that replaced the list

The sweep is the same closure D63's loader uses — anchored at `seed_anchor`, walked over `pg_constraint`, `UNION`
so a cycle terminates — and it writes its arithmetic to a temp table that two checks read:

- **the census**: `swept >= 20`, where `swept` is the number of closure members outside the anchor the sweep
  actually counted (measured **29 of 52** on V1–V7, floor at two thirds — D62's rule, for the same reason: "all
  clear" and "looked at nothing" are the same shape);
- **the claim**: `blockers = '' AND swept > 0`. The second conjunct is not decoration. Without it, a sweep that
  reached nothing reports a clean database, which is the failure this file exists to catch.

`blockers` names every table outside the anchor that holds rows, with its count, and the detail says what kind of
finding that is: *this database is the seed plus traffic, so quality.sql is reading it as a diagnostic and not as
a gate on the artifact.*

### 4. Four verdicts, in both directions

Run against the gate's own freshly-loaded database (`--keep`, so the same rows the gate passed are the rows
mutated):

| | Verdict |
| --- | --- |
| **(a)** clean | `PASS=173 FAIL=0` — census: `29 of 52 closure table(s) lie outside the anchor and were counted (the hand list this replaces named 4)`; claim: `29 referencing table(s) all empty` |
| **(b)** closure arm blinded (`SELECT fk.conrelid` → `SELECT NULL::oid`) | **RED 2** — census `0 of 23 … were counted`, claim `the closure reaches nothing outside the anchor, so this row has no evidence either way — that is a defect in the sweep, not a clean bill of health` |
| **(c)** one row planted in `share_links` | **RED 1** — claim `written elsewhere: share_links (1 row(s))`, while the census stays green at 29. The old four-name row would have printed PASS. |
| **(d)** that row deleted | `PASS=173` again |

(b) and (c) are the two directions a check has to be able to fail in: going blind, and seeing something the
previous check could not. Each mutation was reverted from a byte-for-byte backup and the file's `md5sum` re-checked
before (d) ran. The gate's total went 172 → 173 checks (−1 hand row, +2 catalogue rows), and adding
`moderation_cases` to the anchor's FK sweep introduced no new row because nothing points at it — 91 `fk:` rows
before and after.

### 5. What the sweep said about the demo database, reported rather than repaired

Pointed at the long-lived `nexus` database the new check is red, and honestly so:

```
no traffic outside the seeded tables — written elsewhere:
  agent_runs (40), audit_logs (53), events (35), referrals (1), reservations (6)
```

`docs/STATUS.md` still carries a row claiming "all 150 checks passed" there, measured 2026-09-22 against a
database that has been used since. Seven other checks are red on `nexus` for the same kind of reason (1,727
reviewed subjects without a rating fact, 544 waiting reviews without an open case, 171 facts with an undeclared
source, 12 lapsing human grants, 3 owner memberships lacking `admin_members`, an empty moderation queue) — rows
written out of band, or part of the artifact reloaded on top of traffic. Repairing that means
`RESEED_DEPENDENTS=1` against a shared demo database, which would delete another stream's walk evidence, so it is
reported here and not executed; the file's header now states what it is a gate on, and what it is when pointed
somewhere else.

### 6. What D64 does not claim

- The sweep sees foreign keys, nothing more. The eleven unconstrained reference columns D63 §6 lists are outside
  its reach, so a row fabricated into one of those tables still passes — a polymorphic `subject_id` is invisible
  to any catalogue.
- **Empty means "no rows", not "no rows that matter".** A table in the closure that legitimately carries
  non-seed content in a given environment (a live deployment's `audit_logs`) makes this check red by construction.
  That is the intended reading of a *seed* gate, and it is why the census row and the claim row are separate.
- `swept >= 20` is a floor, not a ceiling. If V8 adds a child of `users`, the census counts 30 and nobody has to
  edit this file — which is the property the four-name list never had, and the reason the floor is written as a
  fraction of a measured number rather than as whatever the list happens to name today.

## D65 A polymorphic column no check had ever resolved — 2026-09-25

### 1. The hole in the middle of two working shapes

D64 left a remainder it could not close: columns that name a reference and carry no constraint, so neither the
loader's closure nor the traffic sweep can see them. Counting them by hand first gave "eleven", which is why §60's
`next` pointer names that number; counting them from the catalogue (below, §4) gives 25. Either way
`facts.subject_id` is the largest — 5,688 rows —
and every existing check around it reads `JOIN merchants` or `JOIN offerings`. Both of those
shapes are sound *for the types they join*, and both have the same hole in the middle: a fact whose `subject_type`
is a type nobody joins is invisible to all of them at once. Measured, that hole had an occupant: **684** facts are
`location` observations (`address`), and no check in the file had ever asked whether a location fact points at a
location.

### 2. The set is closed, and the fifth name is a finding

`favorites` and `permission_grants` already had probes for this: build a `(type, key)` set out of the tables each
type names, group the facts by their declared type, and let a type the probe does not know be an orphan by
definition. The same shape went into `facts`, over four types: `merchant`, `offering`, `location`, `review`.

It is closed and named for the same reason D62's describer list is: closing it is what turns an unknown into a
report. V1's own comment declares the set as `merchant|offering|location|review|policy`, and `policy` resolves to
no table in the schema — there is nothing a policy id could point at — so the probe deliberately leaves it out and
the check's comment says why. A fact keyed to a policy is unresolvable by construction; whoever wants to write one
has to decide what it refers to first, and that decision belongs in a check's comment and a migration, not in a
JOIN that quietly narrows the claim.

### 3. Two plants, both red, and the groups that stayed green

Run on the gate's own freshly loaded database (`--keep`), against the rows that had just passed 176 checks:

| | Verdict |
| --- | --- |
| clean | `PASS=176 FAIL=0`, exit 0 — 173 → 176 as the probe adds one row per type present (`facts.merchant` 2,080, `facts.offering` 2,924, `facts.location` 684 = the whole 5,688-row table) |
| plant a `merchant` fact whose id is random | **RED** `orphan: facts.merchant — 1 unresolvable of 2081 fact(s)` — the 2,080 seeded merchant facts plus the plant, while `location` and `offering` print `0 unresolvable` on the same run |
| plant a fact with the invented type `policy` | **RED** `orphan: facts.policy — 1 unresolvable of 1 fact(s)`: a type nobody joins gets its own row instead of being dropped by a join that never mentions it |
| delete both | `PASS=176` again, `facts` back to 5,688 rows, exit 0 |

The two plants were run twice. The first fixture was written in a hurry and broke two other checks on its way
through the door (`every source_uri is demo://`, `facts all carry expires_at`), so the run reported three reds and
proved nothing about which arm caught what. Re-planting with `demo://` provenance and a TTL left exactly one
witness per plant and nothing else — `2 check(s) failed`, both of them `orphan: facts.*`. That is the version
counted above. Two things fall out of it: a fixture has to be legal except in the one dimension under test, and
`facts all carry expires_at` is alive — it caught a fact row written without a TTL on its own account, the third
independent witness in this file that a fact row has to be a complete claim, not just a resolvable one.

### 4. What D65 does not claim

- The probe resolves *types*, it does not vouch for *meaning*. A location fact that points at a real location can
  still carry a wrong address; that is what §19/§20's `source`/`confidence`/`expires_at` are for, and this check
  is not a substitute for them.
- Measuring the remainder properly changed its shape. Replacing "eleven, by hand" with a catalogue predicate
  (`*_id`, no foreign key, not its own table's single-column PK or UNIQUE) gives **25** unconstrained reference
  columns in the schema. Of those, the seed writes **five** — `facts.subject_id` 5,688, `moderation_cases.subject_id`
  544, `permission_grants.subject_id` 36, `favorites.subject_id` 18, `user_identities.provider_id` 5 — and D65's
  probe now covers the largest. `favorites` and `permission_grants` already had the same shape. That leaves the
  five seeded columns in two groups: this probe reaches `facts`, and `user_identities.provider_id` is *not* a
  reference at all — it is an external opaque subject id that points outside the database, so a `JOIN` would be
  wrong; `moderation_cases.subject_id` has a `JOIN reviews` but is scoped to the one type the generator emits
  (`review`, 544 rows), so the check is sound for the shape the seed actually writes and blind to types nobody
  ships. Twenty of the 25 columns live in tables D64's sweep already refuses to seed over.
- Measured while writing this: `moderation_cases` holds **0 rows** in the long-lived `nexus` database while the
  fresh gate database has 544 open cases (that is the `the queue has something in it` row red on `nexus`). The seed
  writes them, so something consumed or deleted them out of band. Reported, not chased — it is the same drift D64
  §5 records, seen from a different table.


## D66 The census of a file's own blind spots — 2026-09-25

### 1. The remainder moved into the file

D65 measured its own remainder with a throwaway python script: 25 columns in `public` name a reference and carry
no constraint (any `*_id` with no foreign key that is not its own table's single-column PK or UNIQUE), and the
seeded dataset writes five of them. A measurement that lives in a script in `AppData\Local\Temp` is a fact about
one afternoon, so the measurement moved into `quality.sql`: a plpgsql pass over `pg_attribute` counts rows and
non-empty values per candidate column, and a four-row group joins that census against a registry that says why
each answered column is answered.

The registry is a hand list, and that is the point. What the catalogue decides is **who has to answer**; the list
only supplies answers. A new unconstrained `*_id` column that the seed starts writing has to be registered with a
reason before the gate goes green, which is the opposite of the old shape, where the file asked about the columns
someone happened to think of and printed nothing about the rest.

### 2. Three kinds of answer, and the one that watches itself

`kind` is `probe` (an orphan probe resolves the column by declared type), `join-one-type` (a `JOIN` covers the one
type the generator happens to emit), or `not-a-reference`. Today: 3 probe, 1 join-one-type, 1 not-a-reference.

The middle kind is the interesting one, because a waiver is exactly as good as the assumption under it.
`moderation_cases.subject_id` is waived as `join-one-type` — the queue checks `JOIN reviews`, while V1:574 declares
`review|merchant|document|message|listing`. So the fourth row re-reads the assumption every run: for every waived
column, how many distinct `subject_type` values does that table actually ship? While it is one the waiver is true.
The moment the generator emits a second type the row goes red by itself, and the waiver cannot quietly outlive the
fact that made it honest.

### 3. Three falsifications, on the gate's own loaded database

| | Verdict |
| --- | --- |
| clean | `PASS=180 FAIL=0`, exit 0 — 176 → 180. Census row prints `25 unconstrained *_id column(s)`; the registry row prints `0 stale of 5 registered (join-one-type 1, not-a-reference 1, probe 3)`; the waiver row prints `moderation_cases.subject_id ships 1 subject_type(s)` |
| blind the census predicate (one added `AND a.attname = 'no column is ever called this'`) | **RED ×3** — `0 unconstrained *_id column(s) measured`, `0 of 0 carry values, each registered — this row cannot pass on an empty census`, and `5 stale of 5 registered`. The conjunct D64 added for a sweep that reaches nothing is what keeps an empty census from printing as a clean bill of health |
| create `probe_d66(thing_id uuid)` with one row | **RED** `every reference the seed writes is probed or explained — probe_d66.thing_id (1 row(s))`, and nothing else |
| plant a second `subject_type` (`merchant`) into `moderation_cases`, pointing at a real merchant | **RED** `a join-one-type waiver … — moderation_cases.subject_id ships 2 subject_type(s)`, and nothing else — the new case is invisible to every review-joining check in the file, which is the hole the waiver row exists to notice |
| revert all three | `PASS=180`, restored file md5-identical |

The last two plants each lit exactly one arm, which is the standard D65 set after the first fixture turned out to
be illegal in two other dimensions.

### 4. What D66 does not claim

- The census is a naming heuristic, and it knows one of its own members is a false positive: `user_identities.provider_id`
  is registered `not-a-reference` because V1:53 declares it an opaque external subject id. Twenty of the 25 columns
  are in tables the seed never writes, so on the database this gate runs against they carry no rows to be wrong about —
  D64's traffic sweep is what keeps that true.
- Two of the three `probe` arms disagree with the vocabulary the file asserts next to them, and that is reported
  rather than fixed: the favourites probe builds a `user` arm for a subject type no `FavoriteBody` can carry, and has
  no `guide` arm for a type the door does accept (a guide is a `collections` row with `kind='guide'`, so the id would
  resolve but the type string would not, and the row would print an orphan that is not one). Deciding which of the two
  vocabularies is authoritative is a contract decision, not a check edit — task #42.
- The registry's `why` text is written but not printed; the row prints kind *counts*. A reader who wants the reason
  has to open the file, which is acceptable for five entries and would not be for fifty.


## D67 A seeded row the write path refuses to re-create — 2026-09-25

### 1. What the census found on its second run

D66 registered the favourites probe as `probe` but said in its own `why` text that the probe's type set was *not*
the vocabulary the door accepts: it built a `user` arm for a subject type no `FavoriteBody` can carry, and had no
`guide` arm for a type it can. A gap written down as a known weakness is still a gap, so the arms were rebuilt
against the door rather than against the migration comment.

`MeController.FavoriteBody` is `^(merchant|offering|guide|collection)$`, and `assertSubjectInTenant` resolves
`guide` and `collection` against the same `collections` table while **pinning the subject to its kind** — the code
says it out loud: "`guide` is a row of this table labelled otherwise … an id saved under the wrong label has to be
refused rather than resolve later as something else". The probe now joins the way the door joins: four arms,
`collection` only matching `kind = 'collection'`, `guide` only matching `kind = 'guide'`, no `user` arm. The same
house habit as the `permission_grants` probe, which joins the way `AuthorizationInterceptor` does (D31).

### 2. The row that was already in the seed

Pinning the arms is not a refactor, because the dataset did not satisfy it. Measured on the seeded rows:

| | |
| --- | --- |
| `favorites` by type | merchant 12, offering 4, collection 2 — and of the two `collection` rows, **one points at `sha-tin-date-night`, which is `kind='guide'`** (measured against `collections`: 4 rows = guide 1, collection 2, itinerary 1) |
| what the door would do | `POST /api/v1/me/favorites` with that pair is a `404 subject_not_found`: `CollectionsRepository.isPublishable` ends in `and c.kind = :kind` (CollectionsRepository.java:175), so asking for a guide row under the label `collection` counts zero and `assertSubjectInTenant` refuses — a favourite the seed ships and the API cannot re-create |
| what the read side does | nothing different: `IdentityRepository.listFavorites` selects the rows with no `subject_type` branch, so the served list keeps the same 18 rows either way — the defect was in the label, and only the label |
| the generator | `build_collections()` returned `dict(id, slug)` with no `kind`, and the favourites loop hard-coded `"collection"` for `guides[:2]`, so a guide could only ever be emitted as a collection |

The fix is one field threaded through (`kind=kind`) and the loop emitting `g["kind"]`, with the reason in the
comment beside it: the seed has to say what a row actually points at. Nothing was invented — the type was already
declared in V1:619, the door's pattern, and `FavoriteBody`; the generator was the only party disagreeing.

Reported rather than fixed: `weekend-family-sha-tin` is `kind='itinerary'`, and no favourite type exists for an
itinerary in either the door's pattern or V1's comment, so that row is unshareable through `/me/favorites` by
construction. That is a product question, not a seed bug.

### 3. Falsification, including yesterday's dataset

| | Verdict |
| --- | --- |
| clean, freshly loaded by the gate | `PASS=181 FAIL=0`, exit 0 — the probe now prints one row per type *present*, so 180 → 181: `favorites.merchant` 12, `favorites.offering` 4, `favorites.collection` 1, `favorites.guide` 1 |
| put yesterday's label back (`UPDATE favorites SET subject_type='collection'` on the guide row) | **RED**, one row only: `orphan: favorites.collection — 1 unresolvable of 2 row(s)`. The dataset as it stood before this decision is the fixture, which is the strongest form of the demonstration — the new arm catches the shape the old one could not see |
| invent a fifth type (`itinerary`, which does exist as a `collections.kind`) | **RED ×2**: `orphan: favorites.itinerary — 1 unresolvable of 1 row(s)` *and* `favourite subject_type is one the API can save — 1 unsavable row(s); the door accepts merchant, offering, guide, collection`. Two independent arms, one because no probe knows the type and one because the door refuses it |
| restore the labels from the row's own `kind` | `PASS=181` again, exit 0 |
| e2e surface | not re-run, and the reason is measured rather than assumed: `grep -rn "favorite\|favourite" scripts/e2e_fresh.sh` returns nothing, and `listFavorites` has no `subject_type` branch, so no served read in that gate reads the label this change touches |


### 4. What D67 does not claim

- The probe resolves the id *and* the label. It does not decide whether a guide should be saveable as a
  collection — the door already refused that, and this check now refuses the data. If someone later widens
  `FavoriteBody`'s pattern, both the probe arms and the `favourite subject_type is one the API can save` row have
  to move together, and the second one will go red first.
- The registry entry for `favorites.subject_id` still says `probe`, and now says so truthfully: it is a probe over
  the four types the door accepts, not over four names someone remembered.
- `moderation_cases` still carries the one remaining `join-one-type` waiver, watched every run by D66's census
  rather than probed. Giving it a real `(type,key)` probe over V1:574's five types is the next task.
## D68 The moderation queue's other four types — 2026-09-25

### 1. A waiver watched is not a waiver answered

D66 registered `moderation_cases.subject_id` as `join-one-type` and built a row that re-reads the waiver's
assumption every run — `moderation_cases.subject_id ships 1 subject_type(s)`. That is honest, and it is still only
a thermometer: the day the generator emits a second type, the row turns red and somebody has to write the probe
anyway. D67's lesson was that a gap written down tends to stay open, so the probe got written now and the waiver
retired; the registry line prints `probe 4, not-a-reference 1` and no `join-one-type` at all.

The hole was the same size as the one D65 closed. V1:574 declares `review|merchant|document|message|listing`; the
seed emits 544 cases, every one of them `review`; and every queue check in the file reads `JOIN reviews`. Four
declared types had never been resolved by anything.

### 2. `listing` is the fifth name again

The arms are `review` → `reviews`, `merchant` → `merchants`, `document` → `documents`, `message` → `messages`.
`listing` is deliberately absent, for the reason D65 gave about `policy`: no table in this schema is a listing, so
there is nothing a listing case could point at. Including an arm for it would mean inventing a meaning —
`listing` → `offerings`? — and a check is not the place to decide a contract question. Left out, a seeded listing
case is an orphan by construction and prints its own red row, which is the honest reading and the one that forces
the decision into a migration where it belongs.

Worth naming so nobody reads more into it than it holds: on a database with an empty queue the probe contributes
**no** rows, because it groups by the types actually present. An empty queue is not this row's to judge, and the
file already refuses it by name (`the queue has something in it (an empty inbox is not …)`), which is red on the
long-lived `nexus` database for the third decision running.

### 3. Plants

Every plant is inserted into the kept gate database, schema-legal in every dimension except the one under
test. As first written this paragraph said the CHECK at V1:574 accepts all five names — **there is no CHECK
there**. D69 measured 11 of the schema's 12 polymorphic type columns as bounded by nothing at all; only
`share_links.subject_type`, added in V7, carries a constraint. The plants were legal for a stronger reason than
the one recorded here: no database rule touches the column, which is exactly why a probe has to. The measured
rows below are unchanged.

| # | planted | expected |
| --- | --- | --- |
| A | one `merchant` case, `subject_id = gen_random_uuid()` | red: the arm exists, the key resolves to nothing |
| B | one `listing` case, likewise | red: no arm at all, so an orphan by construction |
| gate | both plants present | the file refuses, and counts its refusals |
| C | control: one case on a real `merchants.id`, one on a real `documents.id` | green, with two more rows than before |
| — | plants removed | back to the shipped number |

Measured, in order — the gate prints one row per (type actually present), so A and B arrive as two named rows:

```
FAIL  | orphan: moderation_cases.listing     | 1 unresolvable of 1 case(s)
FAIL  | orphan: moderation_cases.merchant    | 1 unresolvable of 1 case(s)
psql:<stdin>:1132: ERROR:  quality gate: 2 check(s) failed:
    - orphan: moderation_cases.listing
    - orphan: moderation_cases.merchant
NOTICE:  quality gate: all 184 checks passed          (control: two legal cases, two new type groups)
NOTICE:  quality gate: all 182 checks passed          (plants removed)
```

A and B are the two halves D61's rule asks for: A fails because a **key** does not resolve, B because a **type**
has no resolver. A probe that only ever failed would pass neither test usefully — B would look like success for
the wrong reason and A like a broken join — so C is the load-bearing row. It shows `merchant` and `document`
*can* resolve, and it shows the probe groups by type rather than lumping the queue into one number.

The registry census, which is what D66 built to make this visible:

```
PASS  | the registry names no column the schema has lost  | 0 stale of 5 registered (not-a-reference 1, probe 4)
PASS  | a join-one-type waiver is only true while the table | no waiver of that kind is registered
```

That second row now guards an empty set, which is the shape §63's pointer predicted. It stays because the
alternative — deleting the row when its set empties — would make the next `join-one-type` waiver nobody bothers
to answer invisible again. It says "none registered" rather than going quiet.
## D69 Twelve polymorphic pairs, four probes, and one CHECK — 2026-09-25

### 1. The census, and the two numbers it gave back

D64, D65, D66 and D68 all closed the same species of gap one instance at a time: a check that reads a hand list
where the schema could be asked. This one asks the schema a question nobody had asked it — which columns come in
a `(type, key)` pair — by shape rather than by memory: every table holding both `stem_type` and `stem_id`. The
shape rule drops `documents.mime_type` and `messages.content_type` on their own, with no exception list, because
neither has an `id` sibling.

Two numbers came back, and the second was not expected:

```
12  (type, key) pairs in public
 1  of them bounded by a CHECK constraint on the type column
```

### 2. Twelve vocabularies, one constraint, and several unrelated lists

V1 writes these domains as column comments — `subject_type text NOT NULL,  -- review|merchant|document|message|
listing` at V1:574, `-- merchant|offering|location|review|policy` at V1:539, `-- user|merchant_user|agent|
api_key` at V1:130 — and never turns one of them into a constraint. `share_links.subject_type`, added later in
V7, is the only pair in the schema with a real CHECK.

**Corrected by D71, which measured the weaker half of that first sentence.** "V1 writes these domains as column
comments" is true of the migration's *source text* and false of the database. A join of `pg_attribute` against
`pg_description` over every public column whose name ends in `_type` returns 14 columns and a description on
none of them — the `--` marks inside `CREATE TABLE` are SQL comments, and Postgres discards them at parse time.
So the finding is not "documented but unenforced"; it is that the schema holds neither enforcement *nor*
documentation for eleven of its twelve vocabularies, and the only place any of them is written down outside a
Java constant is lines a reader has to go find in a migration. That is why D71 puts the vocabularies in a table
in this file and re-reads what a database can re-read, instead of citing V1:539/:574/:130 from prose a third
time. The rest of §2 stands unchanged, including the CHECK count.

It would be wrong to conclude from that that nothing bounds them, and the first draft of this section said
almost exactly that, so here is the measured version. The bounding lives in whichever door writes the row, in
constants that have no relationship to one another: `EventsController:63` holds
`user|merchant_user|agent|system|anonymous` for `events.actor_type`; `PermissionService:40` holds
`HUMAN_SUBJECT_TYPES` for grants; `MeController.FavoriteBody:59` holds the four favourite types, which is the
list D67 built its probe's arms from; `CollectionsWriteController:325` validates
`collections.items[].subject_type`; `ModerationController:130` refuses any queue case that is not a `review`.
`facts` and `referrals` matched no such constant in the grep that found those five — which is the absence of a
grep hit, not a proof, and is written that way on purpose.

So the finding is not "the schema is the only guard" and not "the code is". It is that a question with one
answer — what types may this column hold — currently has twelve answers spread over migrations, five Java
classes and this SQL file, and **no single place that can be asked whether every pair is bounded somewhere**.
That is the question the census row answers, and why it prints both counts instead of asserting either.

This corrected a sentence D68 had written an hour earlier. Its §3 claimed the plants were legal because "the
CHECK at V1:574 accepts all five declared names". There is no CHECK at V1:574. The claim was false in the
direction that matters least (the plants really were legal, really did go red) and it was still a claim about
who guards a column that the schema does not guard — the same mistake D50 caught in an §8 sentence about a
permission the table could not express. The correction is in D68's own §3, marked, because a doc that quietly
rewrites itself is worse than one that records being wrong.

### 3. Where the row is green and where it is red — the same row, two databases

On the fresh gate database the row passes, and it is worth being exact about why: the seed writes 4 of the 12
pairs (facts, favorites, moderation_cases, permission_grants — the loader's own headers, 5,688 / 18 / 544 / 36
rows), and those are the same 4 this file probes. Seeded set equals probed set, so no pair is simultaneously
populated, unbounded by the database and unprobed here — which is exactly the sentence the row checks, and no
wider. Its detail prints both counts so nobody has to trust the equality.

On the long-lived `nexus` demo database — the one that has real traffic in it from every E2E run — the same row
named five pairs on the spot:

```
FAIL | a seeded polymorphic vocabulary is bounded or probed | 8 of 12 pair(s) carry seeded rows;
       1 is bounded by a CHECK; unresolved: audit_logs.subject_type (53 row(s), 4 type(s)),
       audit_logs.actor_type (53 row(s), 1 type(s)), events.actor_type (35 row(s), 1 type(s)),
       events.subject_type (35 row(s), 0 type(s)), referrals.referrer_type (1 row(s), 1 type(s))
```

That is the census doing its job in both directions: it can tell "nothing in the demo data is unprobed" apart
from "the application has been writing five unbounded vocabularies for weeks". `events.subject_type` printing
`0 type(s)` is not a bug in the count — the column is nullable (V1:769) and every one of those 35 rows has it
NULL, so `count(DISTINCT)` sees nothing. A pair can carry rows and hold no type at all, and the row says so
rather than rounding it up to one.

The boundary worth stating plainly: pairs the application writes are invisible to this file, which reads the
seed on a throwaway database. `quality.sql` is a gate on the artifact, and on the drifted database it is a
diagnostic — which is the same seam §64 recorded for `updated_at`, and why that finding was left as a report.

### 4. Plants


Two plants, both run against the kept gate database after the green run, and the load-bearing one is P2.

**P1 — a populated pair this file does not probe.** One `referrals` row with `referrer_type='user'` and a
`referrer_id` taken from a real `users.id`: legal under every constraint the schema has (it is the *key*, so it
resolves), so nothing about it is an orphan. The new row is the one that notices it is unprobed and populated:

```
FAIL | a seeded polymorphic vocabulary is bounded or probed | 5 of 12 pair(s) carry seeded rows;
       1 is bounded by a CHECK; unresolved: referrals.referrer_type (1 row(s), 1 type(s)); …
FAIL | every reference the seed writes is probed or explained | referrals.referrer_id (1 row(s))
FAIL | no traffic outside the seeded tables | written elsewhere: referrals (1 row(s)) — …
ERROR:  quality gate: 3 check(s) failed
```

Three rows, three different questions — the pair census, D66's column census, D64's traffic sweep. Worth having
in writing that they agree: three censuses built at four different decisions, on the same inserted row.

**P2 — a pair nobody listed.** `create table d69_planted_pair (id, thing_type, thing_id)` plus one row pointing
at a real merchant. No list was edited anywhere, and the file still found it:

```
PASS | the polymorphic-pair census reads the catalogue  | 13 (type, key) pair(s) measured from pg_attribute
                                                        (12 on this schema; the floor is two thirds of what was measured)
FAIL | a seeded polymorphic vocabulary is bounded or probed | 5 of 13 pair(s) carry seeded rows;
                                                             … unresolved: d69_planted_pair.thing_type (1 row(s), 1 type(s))
```

The first line is the point of the whole unit: the count moved 12 → 13 and the row stayed green, because it
reports what it measured instead of asserting a number it remembers. The floor is the only literal, and it is
deliberately two thirds of the measured value so a census that quietly stopped seeing half the schema goes red
while a schema that grows does not.

Restored (both plants removed, table dropped): `all 185 checks passed`, and the row's own detail says so in
plain terms — `4 of 12 pair(s) carry seeded rows; 1 is bounded by a CHECK; each seeded one is resolved by a
probe here`.
## D70 The events door checks who acts, and never asks what is acted on — 2026-09-25

### 1. The half that was already witnessed

`EventsIngestTest` had three tests about `actor_type`, and they are good ones: an anonymous batch is stored with
forced anonymous attribution; a signed-in caller's actor is the principal "never whatever the payload claimed"
(that test posts `actor_type:"anonymous"` + a random `actor_id` under a user token and reads back `user`); and
the pair/dedup/idempotency limits. D61's rule is that a two-sided thing needs *both* sides visited, and the
other side of this door — `subject_type` / `subject_id` — had no test at all. Not a weak one. None.

### 2. What the door actually does with a claimed subject

`API_CONTRACT.md:516` documents the ingest body as `{events:[{name, properties, occurred_at, session_id}]}`. The
controller reads two more fields from that object — `subject_type`, validated only against
`^[a-z][a-z0-9_]{0,31}$`, and `subject_id`, read as a uuid — and the only thing they must satisfy together is
`subject_type_and_id_must_pair`. Nothing asks whether the type is one this system has, whether the id exists
anywhere, or whether the caller could name that row if it did. So an **unauthenticated** call (anonymous +
`session_id`, which §11 allows) can append an event claiming `subject_type='merchant'` and any merchant's id.

That would be a bookkeeping curiosity except for one join:

```sql
-- V1:1015, inside v_merchant_funnel
LEFT JOIN events e ON e.subject_type='merchant' AND e.subject_id = m.id
```

and that view is what `MerchantOverviewController`, `AnalyticsRepository:41` and `MerchantContentController:410`
answer the merchant-facing funnel with. Measured, in the new tests: a published merchant starts at
`views = 0`, one anonymous POST naming it puts `views` at **1**. The counts a merchant reads are, in that
direction, client-assertable.

### 3. Where the contract already covers this, and where it does not

Read fairly, the contract's own sentences cover less than hoped and more than feared:

- "never validates a business invariant" — so accepting an unresolved subject is *consistent* with the design,
  not a violation of it. This is not a bug report against the door; it is a gap the contract does not close.
- "must not be used as a write path for anything a user can see — an event is an observation, not a record." The
  event row itself is not displayed, so this clause is not breached; but the clause's whole purpose is that
  nothing a user sees should be constructible through this door, and a funnel number shown to a merchant is
  something a user sees, built out of what this door accepted.
- "no free-text field is stored and nothing collected here may influence organic ranking (§66)." The §66 half
  holds, and it is worth being exact about how that was checked: grepping `src/main/java` for
  `from events|join events|v_merchant_funnel|v_north_star` returns the merchant-facing side
  (`AnalyticsRepository:41`, `MerchantOverviewController`, `MerchantContentController:410`,
  `MerchantAnalyticsRepository`, `CustomerRepository`), two admin report readers (`AdminAiRepository`,
  `AdminSearchAnalyticsRepository`) and `MeController:158`, whose export selects on the *actor* — which is the
  server-computed half — and echoes the claimed subject back to its own owner. No ranking or search-scoring query
  is in that set; search **analytics** is a report, not a rank input. The free-text half is a reading question,
  not a finding: `subject_type` is bounded by the same kind of shape rule as `name`, so calling one free text and
  the other not would be arbitrary. Stated as a question, not as a defect.

So the honest summary is: a documented-as-append-only telemetry door accepts an unvalidated `(type, key)` pair
that a shipped view turns into a merchant-visible count, and no rule anywhere says that is allowed or forbidden.
Deciding it — resolve the key, or drop client-claimed subjects for anonymous callers, or document the pair in the
body and mark the metric as unverified — is a contract change and is left as an open decision, not implemented
here. What ships today is the witness, so that whoever decides knows which way the tests will move.

### 4. Mutations: two candidate fixes, and they do not catch the same thing


Two candidate fixes, applied one at a time to `EventsController.validate`, each with the source restored before
the next. Both were chosen because they are the two *different* things someone might mean by "validate the
subject"; the matrix is what makes them different.

| # | mutation | what it simulates | red | green |
| --- | --- | --- | --- | --- |
| M1 | the shape check becomes a declared set (`merchant`, `offering`, `location`, `review`) | reject a type the system does not have | `undeclaredSubjectTypeIsAccepted:177` | the funnel test, the pair test |
| M2 | the pair is dropped on ingest (`subjectType`/`subjectId` forced to null) | ignore what the caller claims | all three new tests | none of them |

M1's **green** is the finding, and it is the reason this unit stops at a witness. Under a declared vocabulary,
`claimedSubjectIsStoredAndMovesTheFunnel` still passes: `merchant` is one of the four names, and the id it names
is a real merchant's — so the funnel count still moved on an anonymous caller's say-so. Narrowing the type
vocabulary closes the loud half (the `not_a_declared_type` row) and leaves the half that reaches a merchant's
screen exactly where it was. Any fix that resolves the *key*, or restricts who may claim a subject, is a
different change than any fix that restricts what a subject may be called, and the two are not interchangeable.

M2 is the mirror: it kills all three, including `subjectMustArriveAsAPair` — dropping the pair unconditionally
also drops the pair *rule*, which is the one guard this door has today. A test that had survived that would have
been pinning nothing.

Run on the restored tree afterwards: `Tests run: 12, Failures: 0`. `git status` shows no residue; the driver
refused to start if a mutation string was already present, restored each case from an absolute-path backup, and
the final `grep -c mutated` over the source printed `0`.

## D71 An arm no door can fill, and a type every key fills — 2026-09-25

### 1. Three vocabularies for one column, and the probe was the odd one out

`permission_grants.subject_type` is named in three places, and before this decision no two of them agreed:

| where | the list it holds |
| --- | --- |
| `V1__init.sql:130` (source comment only — see D69 §2's correction) | `user\|merchant_user\|agent\|api_key` |
| `PermissionService.java:40` `HUMAN_SUBJECT_TYPES` | `user`, `merchant_user` — and its javadoc says so: "the two spellings a human being's grants are filed under" |
| `quality.sql`'s probe arms, since D31 | `merchant`, `user`, `merchant_user` |

`merchant` appears in exactly one of the three: the one that is a check. It is in no migration comment, no Java
constant, and no call site. `PermissionService.grant()` is type-parameterised (:133), and the three places that
supply a subject type to a write are `MerchantService.java:63` and `MerchantWorkspaceService.java:177` (both
`"user"`) and `ApiKeyService.java:67`'s own insert (`"api_key"`); the only other subject literals in that file
are :146-147, which read the *operator's* grant under `user`/`merchant_user` as a guard rail. Nothing files a
grant as `merchant`. So the old arm resolved a row that cannot exist: a green that answers a question nobody is
allowed to ask.

`api_key` appears in two of the three and not in the probe. That is the expensive direction. `PermissionService
.has/grantedPermissions` are type-agnostic — they take `subject_type` and `subject_id` from the principal — and
`Principal` can be authenticated as `api_key` with `subjectId = api_keys.id`. Every key the merchant console
creates therefore writes one grant per scope, and `MerchantWorkspaceTest.java:404` counts those rows after a
real `POST /api/v1/merchant/api-keys`. An orphan probe with no `api_key` arm reports each of those legal rows
as an unresolvable subject. Nothing in the shipped seed writes api keys, which is the only reason that false red
never reached a gate run.

The two errors are the same error D67 found in `favorites` — a probe's arm list written from what seemed
plausible rather than from what the door produces — recurring in a table nobody had re-read. That is the only
interesting thing about it, and it is why the fix here is not just the arm list.

### 2. The arms now answer to the interceptor, and to nothing else

```sql
SELECT 'user'::text parent, id::text k, NULL::uuid m FROM users
UNION ALL SELECT 'merchant_user', u.id::text, mu.merchant_id
  FROM merchant_users mu JOIN users u ON u.id = mu.user_id WHERE mu.status = 'active'
UNION ALL SELECT 'api_key', id::text, NULL FROM api_keys WHERE revoked_at IS NULL
```

Three arms for the three types this build files grants under, each resolved the way the code that would consume
the grant resolves it: the person plus an active membership at that merchant (D31's finding — a grant keyed to a
`merchant_users` row id is unreachable, because both interceptor lookups are ids on `users`), and live keys only,
because `ApiKeyService.verify` looks a key up with `k.revoked_at is null` — a grant filed under a revoked key
authorises nothing, so it is filtered exactly like the membership. `merchant` is gone, and its absence is argued
in the file's own comment rather than left for the next reader to rediscover.

Two things deliberately did not ship. No `agents`/`policies`-style arm was invented for `agent`: `agent_profiles`
holds a workspace's AI configuration, not an authenticatable subject, and the AI service enters through
`AiServiceTokenGuard` (D12), so a row filed as `agent` stays an orphan by construction and prints its own red.
And no api_key row was added to the seed: that would mean shipping a credential-shaped fixture, which is a
product-data decision this lane does not own. The arm's reachability is instead witnessed by the Java test above.

### 3. The vocabulary written down as data, and the four halves a database can re-read

`quality.sql` now carries `poly_vocab` — 18 rows, one per (table, type) this file's probes and the migration
comments name across `facts`, `favorites`, `moderation_cases` and `permission_grants` — with two declared
dimensions and a reason per row:

- `kind` is `arm` (the probe resolves it against `referent`) or `no-referent` (the migration names it and no
  table spells it, so a row of that type is unresolvable *by construction* and must print red rather than be
  handed an invented join).
- `filled` is `seed` (the shipped generator emits it — re-checked against the live census), `door` (the
  application writes it at the cited file:line — this file cannot see that), or `declared` (only the migration's
  source text names it, and no writer was found).

Plus `poly_arms` (15 rows: what the four `WITH probe AS (…)` UNIONs actually resolve) and `poly_types`, a census
of which types the loaded data actually carries per probed pair, built through the same `pg_attribute` join D69
used so no column name is retyped. Six checks, 185 → **191**:

| row | the question | what it can catch |
| --- | --- | --- |
| `a probe arm is a declared type and every armed type has an arm` | two-way set equality between the registry and the UNION list | a hand edit to one list that the other does not follow |
| `an armed type resolves in a table the schema has` | `to_regclass(referent)` for every `arm` row | a referent renamed or dropped by a migration |
| `a no-referent waiver still names a table the schema lacks` | `to_regclass IS NULL` for every waiver | the day someone ships `policies` — the waiver stops being true by itself |
| `an arm claimed seeded is a type the data still carries` | every `filled='seed'` row appears in `poly_types` with `n > 0` | the generator dropping a type the file still claims exercises an arm |
| `no unlisted type rides in the seeded data` | every type the data carries has a vocabulary row | a new type value arriving that neither list mentions |
| `the arm registry agrees with the probed-pair counts` | `poly_probed.arms = count(poly_arms)` per table | D69's hand counts drifting from D71's registry |

Each of the first four refuses an empty set, which is D64's rule: a row that can only pass one way is not a
check. The `door` rows' file:line justifications are the residue a reader must re-verify in Java — a Java
constant is not in `pg_*`, and pretending otherwise would be the D68 §3 mistake wearing a different hat.

### 4. Falsifications

Eleven cases, run twice: once on the gate database kept from the first build, then re-run end to end on a second
freshly built one (`nexus_gate_60241_1790281956`, `--keep`) so nothing here rests on a single afternoon's output.
The HEAD file and the D71 file are run against the *same* planted rows, so the pair of verdicts is the finding
rather than either one alone.

| # | setup | file | measured |
| --- | --- | --- | --- |
| P0 | no plant | HEAD | green, 185 |
| P1 | 1 live `api_keys` row + 2 `api_key` grants, written the way `ApiKeyService.create` writes them | HEAD | **false red** — 2 reds: the legal rows print as orphans, plus D64's traffic sweep |
| P2 | the same plant | D71 | **1 red** — only the traffic sweep, correctly reporting a row the seed did not write |
| P3 | 1 `merchant`-typed grant keyed to a *real* merchant | HEAD | **false green, and it grew**: 186 checks passed |
| P4 | the same plant | D71 | 2 reds — the orphan row, and the new registry row naming the type the lists do not cover |
| P5 | no plant | D71 | green, 191 |
| M1 | `poly_arms` loses the `api_key` row (the registry still calls it armed) | mutated copy | 2 reds — the two-way equality row and the count-agreement row |
| M2 | `poly_probed`'s grants count 3 → 2 | mutated copy | 1 red — the count-agreement row, and only it |
| M3 | the `policy` waiver's referent `policies` → `reviews` (a table that exists) | mutated copy | 1 red — the waiver row |
| P6 | `create table public.policies (id uuid primary key)` | D71 | the waiver goes red with no edit to any list; after `drop table`, 191 green |
| P7 | `delete from facts where subject_type='location'` | D71 | 1 red — the claimed-seeded arm is no longer exercised |

```
%_type columns measured: 14   with a stored description: 0   without: 14     <- the D69 §2 correction, re-measured
P0  exit=0 reds=0   NOTICE: quality gate: all 185 checks passed
P1  exit=3 reds=2   ERROR:  quality gate: 2 check(s) failed:
      FAIL |no traffic outside the seeded tables   |written elsewhere: api_keys (1 row(s)) — …
      FAIL |orphan: permission_grants.api_key      |2 unresolvable subject_id of 2 grant(s)
P2  exit=3 reds=1   ERROR:  quality gate: 1 check(s) failed:
      FAIL |no traffic outside the seeded tables   |written elsewhere: api_keys (1 row(s)) — …
P3  exit=0 reds=0   NOTICE: quality gate: all 186 checks passed
P4  exit=3 reds=2   ERROR:  quality gate: 2 check(s) failed:
      FAIL |no unlisted type rides in the seeded data |not in the vocabulary: permission_grants.merchant (1 row(s))
      FAIL |orphan: permission_grants.merchant        |1 unresolvable subject_id of 1 grant(s)
P5  exit=0 reds=0   NOTICE: quality gate: all 191 checks passed
M1  FAIL |a probe arm is a declared type and every armed type … |14 arm(s) and 15 armed vocabulary row(s);
                                                                   disagreement: permission_grants.api_key is armed
                                                                   in the vocabulary with no UNION arm
    FAIL |the arm registry agrees with the probed-pair counts   |disagreement: permission_grants declared 3
                                                                   arm(s), registry has 2
M2  FAIL |the arm registry agrees with the probed-pair counts   |disagreement: permission_grants declared 2
                                                                   arm(s), registry has 3
M3  FAIL |a no-referent waiver still names a table the schema … |3 waiver(s) of that kind;
                                                                   now exists: facts.policy -> reviews
P6  FAIL |a no-referent waiver still names a table the schema … |3 waiver(s) of that kind;
                                                                   now exists: facts.policy -> policies
    after DROP: exit=0 reds=0  NOTICE: quality gate: all 191 checks passed
P7  FAIL |an arm claimed seeded is a type the data still carri… |unexercised: facts.location
```

P1/P2 and P3/P4 are the two halves D61's rule asks for: the same rows, the same database, two files, each file
wrong in the opposite direction. P2 is the positive control that keeps P1 honest — the plant is legal in every
dimension the schema guards (`key_hash`, `prefix`, `scopes`, the `granted_by` person, an active membership as
anchor), so the only red it may earn is the traffic sweep's, and it earns exactly that one.

P3 deserves the emphasis it got: the invented arm did not merely pass, it *added a check that passed*. The probe
groups by the types actually present, so a row nobody can write raised the file's own green count 185 → 186. A
gate that gets more impressive as you feed it fiction is the failure mode this whole lane has been circling since
D64 — and it is the reason `no unlisted type rides in the seeded data` prints in P4 rather than staying quiet:
the orphan row says "this key resolves to nothing", which is true but not the point, while the registry row says
"nobody told me this type exists", which is the point.

M1 through M3 are mutations of the registry itself, not of the data — each one edits only one of the two lists so
the row that compares them is the thing under test. M2 reddens one row only, which is the proof the two
comparison rows are not the same question twice.

### 5. What this closes and what it leaves open

D66 §4 deferred this on purpose: "two of the three `probe` arms disagree with the vocabulary the file asserts
next to them … Deciding which of the two vocabularies is authoritative is a contract decision, not a check edit
— task #42." The favourites half was decided by D67 (arms aligned to the four types `MeController.FavoriteBody`
accepts, `guide`/`collection` pinned to the `collections` row kind the way `assertSubjectInTenant` pins them).
This decides the grants half, and it decides it by asking the *door* rather than the comment: `merchant` loses
because no writer can produce it, `api_key` gains an arm because every key produces one, `agent` stays out
because the type has no subject table. Where the migration names more than the door writes, the registry says so
in `filled` rather than quietly arming or dropping.

Left open, named: `poly_arms` is a hand copy of the UNION arms, because SQL cannot read its own `UNION` clauses
back off itself. The equality row catches the registry drifting from that copy; nothing catches the copy
drifting from the UNIONs. The alternative — one UNION generated from `poly_arms` by `format()` — would put the
probe's joins in a string and take the readable SQL out of the file, which is a worse trade for a five-table
list. If the list grows past a dozen, that trade flips and D71's residue becomes the next decision's subject.

**Corrected by D72 the same day: that threshold had already been crossed when I wrote it.** `poly_arms` holds
**15** arms over four tables, so "past a dozen" describes the file as it stands, which makes the sentence a
deadline that is simultaneously already due and impossible to notice. A count is the wrong trigger anyway — the
thing a flat (table, type) list cannot carry is an arm whose *join shape* differs from the others: **four of the
fifteen** already need more than `id::text` (`favorites.collection` and `favorites.guide` each pin
`collections.kind`, `permission_grants.merchant_user` joins through an active membership, and
`permission_grants.api_key` filters on `revoked_at IS NULL`), and a fifth arm of a *different* kind — one the
registry cannot express at all, e.g. a two-column referent — is what would force generating the UNION from the
registry. Stated as a number it was both wrong and unfalsifiable; stated as a shape it can be checked the next
time an arm is added.

## D72 A census that only spoke one suffix — 2026-09-25

### 1. The column the blind-spot census could not name

D66 built a census so that "nobody thought to check it" stopped being a reason a column went unexamined, and it
works — with one flaw: the census asks the catalogue a question in a *naming* vocabulary, `attname LIKE '%_id'`.
D69's pair census had already shown the better shape, where a rule about structure (`stem_type` beside `stem_id`)
drops `mime_type` on its own without anybody maintaining an exception. A suffix is not a property of references;
it is a property of the person who chose the name. So the census was only ever going to find columns named the
way its author named things.

The schema turned out to be explicit about this, in a way nobody had read. Over `public`:

```
11  columns whose name ends in _by
 7  of them uuid
 6  of those 7 carry REFERENCES users(id)
 1  carries nothing
```

The six: `campaigns.approved_by`, `coupons.created_by`, `coupons.published_by`, `refunds.approved_by`,
`seo_pages.reviewed_by`, `share_links.created_by`. The seventh: `permission_grants.granted_by`, V1:136, written
as `granted_by uuid,` with no constraint after it — and it is not that the meaning is unclear, it is that six
of its same-named siblings say exactly what it means. The other four `%_by` columns are text (`campaigns.generated_by`,
`seo_pages.generated_by`, `trust_signals.detected_by`, flyway's `installed_by`): provenance labels, not people.

Nothing else asked either. Both writers supply a real person — `MerchantService.java:63` passes
`principal.userId()`, `MerchantWorkspaceService.java:177` passes `operatorId`, `ApiKeyService.java:67` passes the
owner — and the seed fills the column on all 36 grants with ids that do resolve (measured off the generated CSV:
3 distinct operators, 0 nulls, 0 outside the seeded `users` set). But `generate.py`'s own FK self-check map lists
`permission_grants.merchant_id` and does not list `granted_by`, so the artifact that ships the rows never checks
the one column the schema forgot to bind. On the drifted demo database the application's own 15 grants resolve
too (0 null, 0 unresolvable, 3 distinct) — which is a report about live data, not a gate on the artifact.

### 2. The fix, and what the type condition buys

The census predicate became a union of two naming shapes with a type condition on the second:

```sql
AND ((a.attname LIKE '%\_id' AND a.attname <> 'id')
     OR (a.attname LIKE '%\_by' AND a.atttypid = 'uuid'::regtype))
```

so the count of unconstrained reference columns moves **25 → 26 with no list edited anywhere**, and the four
text columns fall out on their own — the same self-excluding behaviour D69 valued in the pair rule. `granted_by`
is then registered in `ref_registry` under the existing `probe` kind (an orphan probe resolves it, which is
what now exists) rather than a fourth kind invented for one row; and the probe itself is a plain
`LEFT JOIN users`, no type arms, because an operator is not a polymorphic subject. It refuses an empty set: zero
grants, or grants with no operator on them, cannot produce a green, which is D64's rule and the reason the
detail prints the three counts separately (rows carrying an operator, rows carrying none, unresolvable ones).

Two things deliberately did not happen. No migration adds the missing `REFERENCES users(id)` — that is a schema
decision on an already-applied file owned by another stream, and it is reported here instead. And no `not-a-reference`
waiver for `granted_by`, which would have been the cheap green: the column is a person, six siblings prove it, and
the seed and the application both write real ids.

### 3. Falsifications

Run on the kept gate database (`nexus_gate_63484_1790282836`, built by a full `db_gate_fresh.sh` that reported
`RESULT: PASS — 192 quality checks`), then dropped; 0 `nexus_gate*` databases remain.

```
P0   D72 file, clean      192 passed    census detail: 26 unconstrained reference column(s) …
P0b  HEAD file, same db    191 passed    census detail: 25 unconstrained *_id column(s) …
M1   predicate reverted to the *_id shape only
        FAIL |the registry names no column the schema has lost |1 stale of 6 registered (not-a-reference 1, probe 5)
M2   granted_by's registry entry renamed to a column the census does not see
        FAIL |every reference the seed writes is probed or expla… |permission_grants.granted_by (36 row(s))
        FAIL |the registry names no column the schema has lost    |1 stale of 6 registered …
P3   create public.d72_planted (id uuid primary key, actor_by uuid not null) + 1 row
        FAIL |every reference the seed writes is probed or expla… |d72_planted.actor_by (1 row(s))
        census detail after the create: 27 unconstrained reference column(s)
     after drop table                                        192 passed, 26 measured
P1   update every seeded grant's granted_by to a uuid no users row has
        FAIL |every grant names an operator that exists |36 unresolvable granted_by of 36 grant(s)
                                                             carrying an operator (0 carry none), filed by
                                                             1 distinct operator(s); granted_by has no FK
     after restoring a real operator back                   192 passed
```

M1 is the one worth reading twice: reverting the broadening does **not** make the census quiet — it makes the
registry *stale*, because the census and the registry are bound to each other in both directions. That is the
difference between a list with a check next to it and a list that can be contradicted.

P1's plant is coarser than intended and the doc says so: `WHERE subject_type = 'merchant_user'` was meant to
move a handful of rows, and the shipped seed's 36 grants are all `merchant_user`, so it moved every one — 36 of
36 unresolvable rather than a subset. A single-row plant would have needed a predicate on `permission`, and the
verdict would have been the same row; the plant tests resolution, not proportionality.

### 4. What this leaves standing, including about itself

The new row's own detail carries a hand number — `(26 on this schema …)` — and the run printed it beside
measured values of 25 (M1) and 27 (P3). A literal inside a message about measurement is the smell this lane has
been chasing since D69's census row, which has the identical shape (`(12 on this schema; …)`); the numbers are
not load-bearing (the assertion is `count >= 17`, and the count printed first is the measured one), but the
sentence contradicts itself whenever the schema moves. Named here as the next pass's edit, with D69's row
included in it, rather than quietly reworded now: a wording change re-opens the green run this entry is citing.

And `%_by` is still a naming rule, found by a person who happened to think of it. What generalizes out of D66,
D69 and this is not a predicate but a duty: a census must state which naming conventions it covers, because any
other answer the schema gives is invisible by construction. The candidate that would be actually exhaustive —
every uuid column that is not its own key and has no FK — is too wide to gate (it names generated ids, payload
refs and dead columns alike), so the honest form is a widening that stays falsifiable: two shapes now, each with
a plant that proves the other one is not the only thing the file can see.

## D73 A detail line that contradicts its own measurement — 2026-09-25

D72 §4 named this and this is it. Two census rows printed a remembered count inside a message about a fresh
measurement:

```
25 unconstrained *_id column(s) measured from pg_attribute (26 on this schema; …)   <- D72's M1 run
27 unconstrained reference column(s) measured from pg_attribute (26 on this schema; …) <- D72's P3 run
```

Both halves of the same sentence were true at once and the sentence read as a contradiction, because the second
number was a fact about the day the row was written while the first was a fact about the database in front of it.
The assertion itself was never wrong — it compares against a floor (`>= 17`, `>= 8`), and a floor is *supposed*
to be a remembered number; that is how it can catch a census that stops seeing half the schema. What was wrong
was putting a second remembered number in the prose as if it were a measurement.

A sweep of every integer inside a quoted detail string in the file turned up 75 hits, and the class is exactly
two. Everything else is a different kind of number: a requirement citation (§55, §111, §155), a threshold the row
itself enforces (`(0, 20000)`, `> 20 chars`, `21-day horizon`, `ceiling 400`), a `file:line` pointer, or a uuid
literal. The line `'category tree: 10 roots, …'` looks like a member and is not — `10` there is the name of the
contract the row asserts (`= 10`), and its detail already prints `roots=` with the measured value.

Both rows now print the measured count, then the floor, then label the floor's provenance as history:

```
12 (type, key) pair(s) measured from pg_attribute, over every table holding a *_type beside its *_id
   sibling; the floor this row asserts is 8 — two thirds of the count measured when D69 wrote it, and the
   detail prints the measured number, never a remembered one
26 unconstrained reference column(s) measured from pg_attribute, over two naming shapes (*_id, and uuid *_by
   — D72); the floor this row asserts is 17, two thirds of the 25 measured when D66 wrote it, …
```

Measured on a kept gate database, four runs, nothing else changed: shipped 12 pairs / 26 columns / 192 green ·
plus a `d72_planted(actor_by uuid)` row → 27 columns, the unregistered-column red, the census row green on its
own floor · plus a `d73_planted_pair(thing_type, thing_id)` row → 13 pairs *and* 27 columns, two reds naming the
new pair and the new key · both dropped → 12 / 26 / 192 green. The full
`scripts/db_gate_fresh.sh` run that built that database reported `RESULT: PASS — 192 quality checks`; the
database was dropped afterwards and 0 `nexus_gate*` remain.

Worth keeping the reason in prose: a green row whose detail restates a constant is a row that trains its reader
to ignore the detail. The detail is the only part of a census row that says what the schema looks like today, so
it either prints measurements or it says nothing.

## D74 The only vocabulary the database defends is the one no row exercises — 2026-09-25

### 1. Two enforcement sides, and a count that came back as one

D69 counted the schema's polymorphic pairs and found one of twelve bounded by a CHECK. Reading the same
catalogue from the constraint side says something the pair side could not. `public` has 12 CHECK constraints:

```
availability_slots  3   ends_at > starts_at (twice) and capacity_left within [0, capacity_total]
cart_items          2   quantity > 0, and an offering_id/reservation_id either-or
coupons             1   ends_at > starts_at
merchants           1   rating_agg within [0, 5]
offerings           2   rating_agg within [0, 5], price_amount >= 0 or null
reviews             1   rating within [1, 5]
share_links         2   subject_type = ANY (ARRAY[…]) , and code ~ '^[0-9A-HJKMNP-TV-Z]{6,16}$'
```

Eleven of them compare numbers, timestamps, nullity or a code format. One bounds a *set of words*. So
`share_links.subject_type` is the only column on the platform whose vocabulary the database itself defends;
every other enumerated column is bounded in exactly one place, and that place is a Java literal behind a door:

```
ModerationController.java:51   CASE_STATUSES      = open | resolved
MerchantContentController.java:68 OFFERING_STATUSES = draft | active | archived | out_of_stock
MerchantWorkspaceService.java:34 MEMBER_STATUSES   = active | disabled
AdminAiController.java:52-53    RUN_STATUSES       = running | succeeded | failed | fallback | cancelled
ConversationService.java:52     THREAD_STATUSES    = open | handoff | closed | archived
```

The seed writes all of those columns straight from CSV, through none of those doors — which is the exact seam
D67 caught for `favorites.subject_type`, generalised. `data/seed/quality.sql` is the only place the two lists
can be reconciled, so that is where the reconciliation now lives.

### 2. What the reconciliation measured, before any of it was a gate

Nine columns got transcribed (each row of `door_vocab` names the file and line a reviewer can go and read).
Then the live census printed what the shipped data actually carries:

```
5 of 9 catalogued column(s) carry rows; 11 distinct value(s) measured, 0 NULL group(s), none of them outside
the list its door accepts; the 4 catalogued column(s) no row exercises are named in the detail of the CHECK row
```

The containment direction is clean today — the generator never writes a value a door would refuse — and that is
the point of having the row: it is a tripwire on a seam no code path watches. The findings are in the other
two numbers.

**The one defended vocabulary has no data behind it.** The 4 unexercised columns are
`share_links.subject_type`, `reservations.status`, `agent_runs.status`, `conversations.status` — so the only
CHECK on a vocabulary in the entire schema guards a table the shipped dataset never loads. D74 does not call
that a defect (a share code is minted by a request, not seeded, and minting demo links would be inventing
traffic); it is the shape of the enforcement surface, and it is now printed on every gate run.

**`moderation_cases.status` has one arm and no other.** The door says `open | resolved`, the queue's own
`closeCase` writes `resolved`, and all 544 seeded cases are `open`. Two consequences follow, both measured
rather than argued: a fresh install's resolved view is empty, and the losing branch of the concurrency guard
(`where status = 'open'` matching zero rows, which ModerationController.java:137 turns into
`case_already_resolved`) cannot be produced from shipped data by any sequence of clicks. Reported, not fixed:
a resolved case means inventing a reviewer identity and a resolution note, and §127 reserves that for a human
decision.

**`auto_action` is a vocabulary that lives in a comment.** V1:578 declares
`auto_action text, -- none|hide|flag|reject` inside `CREATE TABLE`, which the parser discards (D73's
meta-fact: no `pg_description` row survives it), so the four words exist in the migration's prose and in the
generator's choice, and nowhere else. The only writer in the build emits `'none'`
(ReviewRepository.java:120-127), the seed carries `none` and `flag`, and ModerationController.java:198 serves
the column verbatim to clients. `hide` and `reject` can be produced by nothing in this build. That is a
design decision about §55 that D74 does not have the authority to make, so it is named here and in the gate's
blind-spot paragraph instead.

### 3. The gate: `door_vocab`, and both sides read live

```
door_vocab    9 hand-transcribed (tbl, col, allowed[], door_source file:line, why)   — the door side
vocab_live    a DO loop's per-column GROUP BY over the real table                     — the data side
check_vocab   pg_constraint read live, the ANY(ARRAY[…]) labels parsed back out       — the schema side
```

Three rows, each answering a different question:

| row | question |
| --- | --- |
| a door vocabulary names a column the schema has | is the transcription about this database at all |
| a door vocabulary admits every value the data carries | does the generator stay inside the door |
| a CHECK-bounded column is a door vocabulary too | do the two enforcement mechanisms agree label for label |

The third is the one that keeps the first honest. It reads `pg_constraint` rather than a remembered count, so
the day someone adds `moderation_cases_status_known` the row starts asking about it, and an entry whose labels
differ from the CHECK's is red in either direction. An unparsable CHECK shape reddens it too, rather than
dropping out of the census silently — a check that can only pass one way is not a check.

`db_gate_fresh.sh` counts went 192 → 195.

### 4. Falsification, seven runs on a kept gate database

The first run of P1 is in this table because it failed: `select min(id)` over a `uuid` column is
`ERROR: function min(uuid) does not exist` on Postgres 16, so the plant never applied and the run's green was
about nothing. Re-planted with `order by id limit 1`.

```
P1  update offerings set kind='bundle' …(one row)…
      FAIL |a door vocabulary admits every value the data carrie|5 of 9 … 12 distinct value(s) measured,
             0 NULL group(s), offerings.kind='bundle' (1)
    restore -> kind='service', 195 green
P2  transcription stale: 'out_of_stock' removed from the offerings.status list in a copy of the file
      FAIL |a door vocabulary admits every value the data carrie|… offerings.status='out_of_stock' (249)
P3  alter table moderation_cases add check (status in ('open','resolved','closed'))
      FAIL |a CHECK-bounded column is a door vocabulary too     |2 text column(s) the schema bounds to a
             literal list, namely moderation_cases.status [3 label(s)], share_links.subject_type [4 label(s)] …
P4  the same constraint with the SAME labels: green, and the census count moves 1 -> 2
      PASS |a CHECK-bounded column is a door vocabulary too     |2 text column(s) … moderation_cases.status
             [2 label(s)], share_links.subject_type [4 label(s)] … 7 of 9 catalogued column(s) rest on the
             door alone: agent_runs.status (no rows), collections.kind, conversations.status (no rows), …
P5a insert into door_vocab ('threadz','status',…)      FAIL |a door vocabulary names a column the schema has|
             10 column(s) transcribed from a door list, threadz.status
P5b insert into door_vocab ('offerings','kinddom',…)   same row, naming offerings.kinddom
final unmutated file over an untouched database:        195 checks passed
```

P2 is the interesting pair with P1: the same red can come from the data moving or from the list going stale,
and the detail distinguishes them by naming the column *and* the row count (`(249)` — the seed's own
out_of_stock population) where P1 named `(1)`. P4 is the positive control: nothing in the file was edited,
only the schema gained a constraint, and the row noticed.

### 5. What D74 does not claim, stated as its own blind spot

- **There is no census of data-bounded columns that no door names.** `users.role`, `merchants.status`,
  `reviews.status`, `documents.kind`, `resource_pools.kind`, `categories.kind`, `tenants.status`,
  `user_preferences.kind|source|scope`, `offerings.price_source`, `moderation_cases.auto_action` and the
  `data_origin`/`source` provenance columns are each confined to a handful of values by the shipped data, and
  none of them is in `door_vocab`, because no door enumerates them. A column can therefore be bounded in
  practice and invisible to this gate by construction — the same class of hole D66 named for the reference
  census, and left named rather than papered over with a list of values nobody authorised.
- **A transcription over an empty table is checked only for existence.** Four of the nine entries carry no
  rows, so containment cannot complain about them and the CHECK row has nothing to compare; if their door
  lists drift, nothing in this gate notices. Naming them in the detail (`(no rows)`) is what makes the
  weakness visible rather than implied.
- **The polymorphic pairs stay in `poly_vocab`.** `facts.subject_type`, `favorites.subject_type`,
  `moderation_cases.subject_type` and `permission_grants.subject_type` are owned by the D71 registry, which
  probes them against their referent tables — a stronger check than membership in a word list. Duplicating
  them here would create two hand lists of one vocabulary and need a third check to keep them honest.
- `pg_get_constraintdef`'s printed shape is the parse target, so a Postgres version that formats
  `IN (…)` differently would be caught by the row reddening on an unparsable census, not by silence.

### 6. A transcription error, and the row that was written for it

`THREAD_STATUSES` was first transcribed against `threads.status`. There is no `threads` table — the class
reads and writes `conversations.status`. Measured while checking: `conversations` also has a `state` column,
which is not a rival vocabulary but a jsonb object (`ConversationService.java:337` serves it through
`Json.jsonObject`), so the two columns answer different questions and only one of them is a word list. The
mistake was caught in the `pg_attribute` lookup before the entry shipped; `door_vocab`'s existence row exists
because of it, and P5a/P5b are its proof.

## D75 The census that asks the data instead of the code — 2026-09-25

### 1. D74's residue paragraph, turned into a row

D74 ended by naming what it could not see: "there is no census of text columns whose *data* is bounded while no
door names them". That sentence is a to-do, so this unit went and measured exactly it — for every text column of
every base table, how many distinct values does the shipped dataset actually carry?

```
232 text columns over 58 base tables, ~5 seconds of wall time on the gate database
     — 57 tables this build writes, plus the gate's own `schema_migrations`: the census has no exclusion
       list, so it scans the ledger too and finds one text column there (`version`, 7 values over 7 rows)
 75 carry <= 12 distinct values
 40 survive a window worth defending
 19 more carry 2..12 values but sit below the window's row floor
  2 carry nothing at all: documents.error over 1040 rows, tenants.region_code over 1
```

The ledger is the window's best argument: it satisfies `n <= 12` with room to spare, and only the row floor
keeps a gate from being required to answer for the tool that counts migrations.

### 2. The window is the finding, not the plumbing

`n <= 12` alone is not a vocabulary test, and the 75-column list shows why: four collections give
`collections.title` four values and five users give `users.phone` five. Cardinality there is a fact about how
many rows the demo has, not about the column's meaning — a gate over that window would demand an explanation
for half the text columns in the schema and get 35 of them wrong.

A vocabulary is a column whose values *repeat*, so the window is three terms together:

```sql
n <= 12 AND total >= 20 AND n * 4 <= total
```

Measured effect of each term, in order: 75 → 41 (the row floor) → 40 (the repeat term). The two numbers are
close here because this dataset's small tables are small in a way that the row floor already catches; the
repeat term earns its place on the columns the row floor misses, e.g. `offerings.price_source` with 3 values
over 5,534 rows. A future `favorites` table with three rows and three values will not pass, which is the
point.

Two columns answer **0** distinct values over their rows and both stay inside the window (`0 * 4 <= total`).
That is deliberate: an all-NULL column is the strongest form of "bounded", and `documents.error` — the place a
chunking failure is supposed to be recorded, NULL on all 1,040 rows — is precisely the kind of fact a gate
should keep visible rather than filter out as "no values to look at".

### 3. Four kinds of answer, each re-reading its own assumption

`vocab_answer` gives every windowed column a name and a kind. What makes the list a gate rather than a comment
is that each kind is checked against a live mechanism, so an answer cannot outlive the fact it describes:

| kind | still true when |
| --- | --- |
| `door` | the column is in `door_vocab` (D74's transcription of a Java list) |
| `poly` | the column is a type column of a `poly_cat` pair (D71's registry) |
| `none` | nothing bounds it, the window still catches it, and the reason is non-blank |
| `below` | nothing bounds it and the window has *stopped* catching it — it reddens if the window starts again |

`below` exists because of the first run: `collections.visibility` was written as a `none` row and the staleness
term refused it — 4 rows in `collections` is below the row floor, so the column is not windowed and a `none`
answer claiming it was an answer to a question that is not being asked. The honest fix was a fourth kind, not
a relaxed predicate; the rule now reads the window in both directions.

Of the 44 answers, 9 name a mechanism — 6 inside the window (3 door, 3 poly) and 3 more over tables too small
for the window to catch — while 35 say plainly that nothing in this build bounds the column: 34 `none` and 1
`below`. That is the honest census result: **34 bounded text columns carry values no door, no probe and no
constraint has any claim on.**

### 4. What the list of "nothing bounds it" turned up

Three of the 34 are not neutral:

- **`offering_relations` is a table nothing reads.** `grep -rn offering_relations` returns zero hits in
  `services/platform/src` (main *and* test), zero in `apps/ai` and `apps/web`, and its only other appearance
  is V1's DDL — so 1,162 seeded rows and 3 relation kinds live in a table the shipped build never names.
  D75 reports that; making the platform read it (or not seeding it) is a design call outside this lane.
- **`chunks.embed_model` is named by zero occurrences in `services/platform/src`.** The seed fills it; no code
  reads it back — the usual shape of an audit column that will silently keep the value the generator invented.
- **`reviews.status` and the moderation door are two 3-word lists sharing 2 words.** The seed carries
  `pending|published|flagged`; `ModerationController.java:50` DECISIONS is `published|rejected|flagged`. So
  `pending` is a state no door can write (it exists only because the generator wrote it), and `rejected` never
  appears in demo data at all. D74 measured the same asymmetry one column over (`moderation_cases.status`: 544
  open, 0 resolved) and this is its second instance.

The rest of the 34 are worth the line they cost — `merchants.status` is a four-state machine moved between by
string literals in `MerchantService.java:141-147` with no set behind it, `resource_pools.kind` carries eight
kinds over its 452 rows (chair, class_slot, lane, room, seat, station, table, treatment_room) and the column's
only appearance in Java is a join on `p.id` at `CatalogRepository.java:239` — nothing in the build reads
`kind` at all — and the four market constants (`*.currency`, `*.postcode`, `locations.city`) are bounded
because the demo has one market, which is a fact about the fixture rather than the schema.

**And a fourth, found while measuring the census's own blind spot.** To state the size of the gap the
`atttypid = 'text'::regtype` filter leaves, the shared `nexus_test` database was read (no writes): it holds
232 text columns — exactly the gate database's number — plus 5 `character varying` and 0 `character`. All five
belong to `flyway_schema_history`, i.e. a bookkeeping table, so the census loses nothing a business row can
sit in. That table is itself the finding: `nexus_test` carries **two migration ledgers that disagree with its
schema**. `schema_migrations` — written by `scripts/db_apply_migrations.sh` — lists V1…V6 and never V7, while
`share_links` (V7's table) is present in that database; `flyway_schema_history` holds one hand-written row,
version `6`, script text "infra-owned V1/V2 applied by scripts/db_apply_migrations.sh", installed
2026-09-24. So "how migrated is this database?" has three answers there — 6 in the loader's book, 6 for another
tool's benefit, 7 in the objects actually present — against the fresh gate database's single ledger reading
`migrations=7`. Reported, not fixed: both ledgers, the loader and the app's Flyway config belong to the
infrastructure lane, and the row that reconciles them is a decision about which tool owns the sequence.

### 5. Falsification

Six runs on the kept gate database, plus a re-run of the first plant because it was half-invalid:

```
Q1  alter table categories add column d75_flavour text          (first attempt: the UPDATE died on
    ERROR:  function min(uuid) does not exist — D74's own lesson, repeated one unit later. The red that run
    printed was real but about an all-NULL column, so the plant was re-applied with
    `case when id > (select id from categories order by id limit 1) then 'a' else 'b' end`):
      FAIL |a bounded text column is answered by name|41 of 233 text columns are bounded by the data
             (window: <=12 distinct, >=20 rows, <=1 value per 4 rows), 3 of them by a door list and 3 by the
             polymorphic registry; categories.d75_flavour (2 value(s) over 77 rows)
Q5  update categories set kind = kind || id::text   (77 values: out of the window)
      FAIL |a vocabulary answer is still an answer|… 34 none, 1 below the window … categories.kind (none)
Q2  an answer claims a door the transcription does not carry (merchants.plan as door)
      FAIL |a vocabulary answer is still an answer|… merchants.plan (door)
Q3  an answer of a kind nothing reads ('maybe')     FAIL … favorites.subject_type (maybe)
Q4  door_vocab's offerings.status renamed to offeringz.status
      FAIL |a door vocabulary names a column the schema has|9 column(s) transcribed…, offeringz.status
      FAIL |a vocabulary answer is still an answer|… offerings.status (door)
final unmutated file over an untouched database: 197 checks passed
```

Q5 is the run that distinguishes D75 from a static exemption list: no list was edited, the *data* moved a
column out of the window, and the answer written about it went red by itself. Q4 reddening two rows is the
expected shape — the transcription and the answer about the transcription fail together.

### 6. Non-claims

- The window is a judgement, stated as three numbers, and the 19 columns below the row floor are invisible to
  R1 by construction; the four that have a mechanism are answered as `below`/catalogued so the gap is named,
  but the other 15 (tiny tables like `user_preferences`, `tenants`, `users`) are simply not asked about.
- `n` is measured with `count(DISTINCT col)` over the whole table, exact and un-analysed — which is why the
  census costs ~5 seconds and why it cannot be fooled by a stale `pg_stats`.
- Text columns on tables the seed never loads are scanned too (they carry 0 rows and fail the row floor), so
  this census is about the *shipped dataset*, not the schema; the schema-side question remains D74's
  `check_vocab` and D66/D72's reference census.
- Nothing here changes what any door accepts: the gate gained rows, the build gained none, and no seeded value
  was edited to make a check pass.


## D76 The projections the app reads through carry nothing, and now says so — 2026-09-25

### 1. The question one layer up

D75 counted distinct values in the stored data. The shipped build does not only read stored data: two views are
its analytics surfaces, and nothing had ever asked what *they* carry over the demo dataset. The read sites are
few enough to name exactly, measured rather than recalled:

```
from v_merchant_funnel            AnalyticsRepository.java:41            (1 site)
from v_north_star                 AdminSearchAnalyticsRepository.java:38,48  (2 sites)
funnel_source = "v_merchant_funnel"  MerchantOverviewController.java:68, MerchantContentController.java:410
source = "… + v_north_star …"        AdminSearchAnalyticsController.java:85
```

So the view names reach the client as *declared provenance* — a response field that tells a consumer which
projection the numbers came from — while `MerchantAnalyticsRepository`, the file that mentions the funnel most
often in prose, reads `events`/`reservations`/`orders` directly and is not a consumer of the view at all. That
combination is why the layer deserved its own census: the answer a client reads (`funnel_source`) is a claim
about a projection nobody in the gate had measured.

The block therefore does for views what D75 does for text columns: enumerate every column of every view in
`public` from `pg_class`/`pg_attribute`, aggregate it over the shipped rows, and require an answer by name.

### 2. What the two views actually carry

| view | rows | columns | what they hold |
| --- | --- | --- | --- |
| `v_merchant_funnel` | 520 | `merchant_id` | the only varying column — the view's own grain |
| | | `tenant_id` | one value: the single demo tenant `00000000-…-0001` |
| | | `views`, `clicks`, `actions`, `reservations`, `orders`, `revenue` | the constant `0`, each on all 520 rows |
| `v_north_star` | **0** | all five (`day`, `tenant_id`, `sessions`, `searches`, `fulfilled_intents`) | no rows at all |

The two shapes differ for a structural reason worth stating: the funnel is anchored on `merchants` (520 seeded
businesses) and left-joins its counters, so it produces a row per business full of zeros; the north star is a
`GROUP BY` over `events` (0 rows), and a grouping over nothing produces **no groups, not a row of zeros**. The
admin dashboard's headline chart therefore reads an empty list, which is a different fact from "a series of
zeros" and is answered as its own kind (`norows`) rather than being folded into `const`.

### 3. The zeros are by rule, and the rule sits next to a clause that is not settled here

`events`, `orders`, `reservations`, `carts`, `payments` are empty because D64's fabrication guard *requires*
them to be: it computes the FK closure of the seed's own anchor, sweeps the 29 tables outside it, and fails if
any of them holds a row. So every counter the funnel aggregates is 0 **by construction**, and the gate that
forbids fabricated traffic is the same mechanism that makes the analytics surfaces structurally empty.

On top of that, the funnel's `reservations` arm stacks a second cause: V3's predicate counts only
`confirmed|completed`, and D26 established that no route in this build moves a booking into either state — so
that column would stay 0 even with traffic in `events`.

§109 forbids fake transactions, fake availability and fake prices outright, and the sentence after it allows
demo data that says "Demo / Synthetic" on its face. Seeding a plausible order history would make both views
non-empty and would also be the exact thing the guard exists to prevent; leaving them empty means every
analytics surface in the product ships showing nothing. **That is a product decision and this lane does not
make it.** What the gate does instead is make the consequence visible with the reason attached per arm, so the
day anyone decides to seed transactions, the answers that claim `const 0` go red by themselves rather than
ageing quietly.

### 4. Three kinds of answer, and deliberately no fourth

| kind | still true when |
| --- | --- |
| `const` | one distinct value over rows that exist **and the answer names that exact value** |
| `varying` | distinct values = row count and more than one value, i.e. the column is the view's grain |
| `norows` | the view produces no rows at all |

The `const` answer carries the literal it claims (`0`, or the tenant uuid), so a column that starts varying or
whose constant moves reddens the row without anyone re-reading the prose. There is no `other` kind: a column
that is none of the three has no honest one-word answer here, and an invented one fails the
`answer NOT IN ('const','varying','norows')` term — V5 below proves the block refuses vocabulary it does not
read, the same way D75's registry does.

### 5. Three defects the drive found in the block's own text

The gate's prose is an assertion too, and three of its claims failed before the block was committed:

- **A FAIL row that said "every one answered"** while naming the column that was not. D73's class, arrived at
  again: the detail's fixed phrase contradicted its own aggregation. The phrase now reports a measured count
  (`0 column(s) left unanswered by this block: none` green; `1 column(s) … : v_merchant_funnel.clicks (…)` red).
- **A conjunct that could only pass.** The first draft required `pg_class`'s view count to equal the census's
  own distinct-view count — the same query counted twice, so no mutation could ever have failed it. It is gone,
  and the view count appears in the detail as a fact instead of hiding in the predicate as a tautology.
- **A header comment that named a file which never mentions the views** (`AdminAiRepository`) and called grep
  hits "call sites". The numbers in §1 above replaced it. This is the same failure as a stale gate: prose
  written from memory instead of from the measurement.

And one the *plants* taught: `is_const`/`is_var`/`is_empty` are materialised once, so a plant that edited a
`claimed` literal **after** that UPDATE stayed green — the flags had already frozen the old truth. The drive
needed a third seam (see §6), and with it the run became a real witness. The lesson generalises: a gate that
measures into columns can only be falsified at the moment it measures, so the falsifier must know where the
measurement happens and plant on the correct side of it.

### 6. Falsification

Nine plants against a kept gate database, over three seams — *pre* (before the census, so the census sees the
change), *mid* (between the hand answers and the flag UPDATE, so the recompute sees the claim change), *post*
(after the flags, so only the rows themselves moved). The first drive version had two seams and produced a
green V2, which is what forced the third.

```
V1 post  delete the clicks answer              FAIL a served view answers every column it exposes
       13 column(s) across 2 view(s) …; 1 column(s) left unanswered by this block: v_merchant_funnel.clicks
V2 mid   claimed '0' -> '1' on tenant_id       FAIL a view answer is still an answer
       v_merchant_funnel.tenant_id (const claims 1)
V3 pre   one events row named 'view'           FAIL a view answer is still an answer
       v_merchant_funnel.views (const claims 0), and all five v_north_star columns (norows)
V4 pre   create v_d76_stranger(1, 'x')         FAIL a served view answers every column it exposes
       15 column(s) across 3 view(s) …: v_d76_stranger.alpha, .beta
V5 post  answer = 'maybe'                     FAIL a view answer is still an answer: v_north_star.sessions (maybe)
V6 pre   rename v_north_star away              FAIL BOTH rows: the census now answers nothing for the moved
       columns, and five answers carry `·no such column`
V7 post  why = '' on the orders answer         FAIL a view answer is still an answer
       v_merchant_funnel.orders (const claims 0 ·no reason)
V8 mid   views answered 'varying'              FAIL a view answer is still an answer: v_merchant_funnel.views
       (varying claims 0), with the kind counts shifting 7->6 const and 1->2 varying
V9 post  an answer for a column no view exposes, every exposed column still answered
       FAIL a view answer is still an answer: v_north_star.d76_gone (const claims 0 ·no such column)
baseline and final, unmutated block over an untouched database: both rows green; official gate 199 checks
```

V3 is the row that makes this gate more than a transcription: nothing was edited in the answer list, one
`events` row was inserted, and six answers went red because the mechanisms they describe moved. V3 also had a
false start recorded honestly — the first attempt planted `name='d76_view'`, which the funnel's `FILTER (WHERE
e.name = 'view')` never matches, so it reddened only the north star's `norows` answers and left `views` green.
A plant that misses the predicate it means to disturb is a weak witness, so it was re-run with the name the arm
actually counts. V8 is the mirror image of V2 (the claim moves the other way), and V9 isolates the dangling
direction from V6, where a rename reddened both rows at once.

### 7. Non-claims

- The census reads the shipped dataset, so `const 0` means "zero for these 520 synthetic businesses", not "this
  column is always zero". If the seed starts producing traffic, the row goes red and the answer must be rewritten.
- Only `count(*)`, `count(DISTINCT col::text)`, `count(col)`, `min`/`max` are taken per column: no width, no
  distribution, no timing. D75's residue about widths applies here unchanged, and the `nulls`/`high` columns the
  census collects are carried but asserted by no row.
- The `norows` answers are correct only while `events` stays empty, which is D64's guard's job to keep, not this
  block's; the two rows would fail together if the guard were loosened without touching the answers.
- Nothing here changes a line of Java, a migration or a seeded value: the gate gained two rows (197 → 199), the
  build gained none. The §109 question in §3 is reported for a decision, not decided.

## D77 A view column's kind is read from the data, not chosen by the author — 2026-09-25

### 1. The claim worth testing in D76's block

D76 answered 13 view columns with three hand-set kinds and wrote that refusal of a fourth was a virtue: *"There
is no `other` kind: a column that is none of the three has no honest one-word answer here, and an invented one
fails the `answer NOT IN ('const','varying','norows')` term."* Its V5 plant proved the second half — an invented
label goes red. It never proved the first half, which is the stronger claim: **that every shape the data can
actually take has one of the three names.** That is arithmetic away from a measurement, and the measurement was
not made before D76 shipped.

The plane to measure is (rows the view produces, distinct values the column carries). Three kinds can name at
most three cells. So D77's first act was not an edit but a probe: print the cell each shipped and each planted
column sits in, and ask which cells no shipped kind can answer.

### 2. Two cells had no home, and both are reachable by the change D76 defers

```
=== A  the shipped funnel, before any plant
   CELL v_merchant_funnel.merchant_id | total=520 n=520 | const=NO varying=fits norows=NO
   CELL v_merchant_funnel.views       | total=520 n=1   | const=fits varying=NO norows=NO
=== B  260 events rows added (one 'view' event for 260 of the 520 merchants)
   CELL v_merchant_funnel.views       | total=520 n=2   | const=NO varying=NO norows=NO
=== C3 a probe view column written as NULL::text over the 520 merchants
   CELL v_d77_probe.one_val           | total=520 n=520 | const=NO varying=fits norows=NO
   CELL v_d77_probe.all_null          | total=520 n=0   | const=NO varying=NO norows=NO
```

`total=520 n=2` and `total=520 n=0` are legal shapes of a projection — and D76's block has no word for either.
Worse, the block did not fail quietly on them, it failed *accusingly*:

```
B2  the shipped block over the same plant
    FAIL a view answer is still an answer  |… v_merchant_funnel.views (const claims 0), v_north_star.day (norows) …
C2  the all-NULL column answered 'const'    |… v_d77_probe.all_null (const claims 0) …
C2  the all-NULL column answered 'varying'  |… v_d77_probe.all_null (varying) …
C2  the all-NULL column answered 'norows'   |… v_d77_probe.all_null (norows) …
```

Three attempts, three reds, the same column named each time: a column that is NULL on every row it sits on
cannot be answered by any kind D76 shipped. So a maintainer who later seeded traffic — the exact change D76's
§3 says is a product decision someone may make — would face a gate that is *unsatisfiable except by deleting
it*. A check whose only answer to a legitimate future schema is "wrong" is a check with an expiry date written
by nobody.

One false start is recorded because it is the same trap as D65's plants: the first all-NULL probe was created
**after** the census had run, so its columns were not in the census at all and the reds printed `no such column`
— which tested the dangling-answer conjunct, not the empty cell. The probe was moved to the pre-census seam and
re-measured (the `C2`/`C3` lines above are that run). A falsifying fixture has to be legal in every dimension
except the one under test, and "created before the thing that enumerates it" is one of those dimensions.

### 3. The change: the census decides the kind, the answer must name it

`view_kind` derives the kind from the census's own two numbers and nothing else:

```sql
CASE WHEN d.total = 0   THEN 'norows'     -- a GROUP BY over nothing
     WHEN d.n = 0       THEN 'allnull'    -- NULL on every row it sits on      (D76: no word)
     WHEN d.n = 1       THEN 'const'
     WHEN d.n = d.total THEN 'varying'    -- the column is the view's grain
     WHEN d.n > 1       THEN 'sparse'     -- some rows share, some differ      (D76: no word)
     ELSE 'UNNAMED-' || d.n || '-of-' || d.total END
```

Two virtues of D76 are kept by the rewrite rather than traded away: the vocabulary stays **closed** (an answer
that names something the derivation cannot produce simply never matches — W4 below), and a `const` answer still
carries the literal it claims, so a column whose single value moves reddens the row (D76's V2 survives this
unit unchanged). What is gained is a home for every cell. What is lost is a seam: D76 needed a plant to land
*between* the answer list and the flag `UPDATE`, because its `is_const`/`is_var`/`is_empty` were materialised
per answer and froze whatever the answers said at that moment. A derived kind is read at check time, so moving
a label is a red wherever in the run it moves — W8 is that claim tested, and it is red.

The `ELSE` branch is unreachable by arithmetic (`n` is never negative and never strictly between 0 and 1), and
it stays anyway so that an edit which opens a hole in the `CASE` above prints a named offender instead of
deriving NULL. **No qc row asserts that the branch is empty**, because a predicate that can only pass is the
exact thing D76 deleted one unit earlier; this is a tripwire inside the derivation, not a check about it.

### 4. The two kinds the demo does not exercise are exempted by name, and the exemption reads the derivation

`view_vocab` holds the five names; `allnull` and `sparse` carry a written reason for sitting empty (the funnel
coalesces its counters to 0 rather than leaving them NULL; seven funnel columns are single-valued, `merchant_id`
is the grain, and the five north-star columns have no rows — all because D64's fabrication guard keeps
events/orders/reservations/carts/payments empty). The third row then refuses four things: a derived kind no
vocabulary row names, a vocabulary name the derivation can never produce, an exemption whose cell is *not*
empty, and an unexercised name with a blank or missing reason.

The consequence is deliberate and worth stating plainly: **seeding traffic does not only change a number, it
withdraws an exemption.** W1 shows the machinery doing that with no hand editing at all — one `events` plant
moved `sparse` from "exempted with a reason" to "1 column(s)" and emptied `norows`' cell, and the row went red
for both reasons at once.

### 5. Falsification: eleven plants over the shipped text, on a kept from-scratch gate database

The drive slices the block out of `data/seed/quality.sql` itself, so these verdicts are about the shipped text,
not about a copy. Seams: *pre* (before the census, so the census sees the change), *mid* (after the answer
INSERTs), *post* (after the derivation). Its footer refuses to report anything when fewer than three rows exist,
so a `qc` INSERT that dies mid-run cannot be read as green.

```
W0  none   baseline                                                     all three rows green
W1  pre    events for 260 of 520 merchants                              2 rows red
         FAIL a view answer names the kind the census derives
              offenders: v_merchant_funnel.views answered const, the census derives sparse
                         · v_north_star.day answered norows, the census derives const
         FAIL a view kind is exercised or exempted
              const = 11 column(s), norows = UNUSED no reason, sparse = 1 column(s)
W2  pre+mid  the same plant, `views` rewritten to the derived kind     row 1 green, row 2 no longer names views
W3  pre+mid  an all-NULL view column answered `allnull`                rows 1-2 green over 15 columns,
                                                                    only row 3 red: allnull = 1 column(s)
                                                                    (the new home fits; the stale exemption does not)
W4  post   an invented kind ('maybe') on tenant_id                    FAIL answered maybe, the census derives const
W5  post   a reason blanked on the orders answer                      FAIL v_merchant_funnel.orders gives no reason
W6  post   the sparse exemption blanked while its cell is empty       FAIL sparse = UNUSED, no reason
W7  post   the 'const' name deleted from the vocabulary               FAIL 4 kind(s) in the vocabulary, 3 derived
         (every answer still matched its derived kind — only the bookkeeping row could see this)
W8  mid    an answer's label changed AFTER the derivation ran         FAIL answered sparse, the census derives const
W9  post   an answer deleted                                          FAIL 1 column(s) left unanswered:
                                                                         v_merchant_funnel.clicks (520 row(s), 1 value(s))
W10 pre    v_north_star renamed away                                  FAIL BOTH rows, naming opposite directions:
         FAIL a served view answers every column it exposes
              5 column(s) left unanswered …: d77_moved.day (0 row(s), 0 value(s)), …
         FAIL a view answer names the kind the census derives
              v_north_star.day answered norows, the census derives no such column, …
final none  unmutated block, untouched database                       all three rows green
state after the drive: events=0 public views=2 named v_merchant_funnel+v_north_star leftover-d77_moved=0
```

W10 is the row that pays a debt. §72's residue list ended with *"(d) a view that stops being a view (a table
swap, a rename into another schema) leaves the census with its answer, exactly D75's residue (b) one layer up,
and only a `norows`/`const` claim that no longer matches would notice."* Under D76 that was true — the rename
was caught by a *value* claim going stale. Under D77 it is caught structurally: the census enumerates views by
name, so the renamed view arrives as a stranger (row 1: five columns unanswered under `d77_moved`) and the
hand answers arrive as dangling (row 2: five answers naming a column the census does not have). Two rows, two
directions, one plant.

W3 is the one that keeps this honest about the refactor's *own* cost: giving `allnull` a home immediately made
two rows green that D76 could not have made green at all, and the only remaining red was the exemption the new
kind withdrew. Growing a gate grows its bookkeeping, and that bookkeeping is enforced rather than hoped for.

The official gate ran twice over this block — once before a comment de-duplication pass, once over the text that
ships — and both printed `RESULT: PASS — 200 quality checks` (199 → 200: one D76 row became two). The three rows
were read off the kept from-scratch database and print `PASS` there with the details quoted in §4 and §5.

### 6. What this does not claim

- The derivation reads only `count(*)` and `count(DISTINCT col::text)`. `nulls`, `low` and `high` are still
  carried by the census and asserted by no row except `low`, which `const` answers must name. D75's residue
  about widths and distributions applies here unchanged.
- The kind names describe the shipped dataset. `const 0` on the funnel counters means "0 across these 520
  synthetic businesses because D64's guard keeps the base tables empty", not "always 0". W1 is the measurement
  that says what happens if that stops being true.
- The `ELSE` branch has no witness: no plant reaches it, because reaching it would require a distinct count that
  is neither 0, 1, nor greater than 1. It is defended by arithmetic and by the offender string, not by a test —
  and it is stated here rather than left for a reader to assume.
- A view **swapped for a table** (`relkind` moves from `v` to `r`) should redden row 2 by the same mechanism as
  W10, since the census filters on `relkind = 'v'`. That is reasoning from W10, not a plant: the swap was not
  performed. It is listed as residue, not as evidence.
- Nothing in this unit changed a line of Java, a migration, or a seeded value; the §109 question D76 raised —
  whether the shipped demo should stay empty or carry marked synthetic transactions — is still not decided here.
  The gate got one row (199 → 200), the build got none.

## D78 A census that says "every text column" speaks exactly one of the schema's string types — 2026-09-25

### 1. The claim worth testing in D75's block

D75 replaced a list of columns somebody remembered with a query over the catalogue: *"for every text column of
every base table, how many distinct values does the shipped dataset actually carry?"* It counted 232 such
columns, and it printed that number in its header as the cost of the block. Every one of those sentences is
true of the block's WHERE clause —

```sql
AND a.atttypid = 'text'::regtype      -- what D75 shipped with
```

— and `atttypid = 'text'::regtype` is a predicate about one type, not about strings. The plane to measure
before believing "every" is therefore not the data but the **type system**: which types in this schema hold
strings at all, and does the census see all of them?

### 2. The measurement, taken before any edit

`pg_type.typcategory = 'S'` is the string category, and a domain must be resolved through `typbasetype` or a
column typed on a domain escapes the same way a citext column did. Measured on the kept from-scratch gate
database:

```
string columns of base tables in `public`        233
  text                                           232
  citext                                           1   -> users.email
  typed on a domain                                0
```

So exactly one column was outside D75's census, and it is not a random one. V1:6 turns the extension on —
`CREATE EXTENSION IF NOT EXISTS citext; -- case-insensitive emails` — V1:32 types `users.email` as citext, and
V4:44 replaced V1:46's global `users_email_uniq` with the tenant-scoped `users_email_tenant_uniq`. A citext
column compares values **without case**; `col::text` does not. D75's census takes `count(DISTINCT col)`, which
is the type's own equality, while the details its rows print go through the cast. For a `text` column those are
the same question. For citext they are two questions, and D75 measured only the first while its prose reads
like the second.

What the shipped dataset does with the difference, measured rather than assumed:

```
users.email | total=5  citext-distinct=5  ::text-distinct=5  widest=24  narrowest=21  rows with an uppercase letter=0
demo.consumer@example.hk, demo.owner1@example.hk, demo.owner2@example.hk, demo.owner3@example.hk, demo.admin@example.hk
```

Every seeded address is lowercase, so the two readings agree here — and the agreement is enforced *outside*
this block, by V4:44's unique partial index on `(tenant_id, email)`, which makes two addresses differing only
by case impossible to insert. The column also sits below the window's row floor (5 < 20), so D75's window asks
nothing of it. Two facts worth a row that re-reads them every run, not a comment that remembers them.

### 3. The change: a reading per type, two readings where the type folds case

The census records each column's base type and pays for the second reading only where the type makes it a
different question:

```sql
IF r.btype = 'text' THEN
  UPDATE vocab_data SET n_txt = n, n_upper = 0 WHERE tbl = r.tbl AND col = r.col;   -- same question, once
ELSE
  EXECUTE format('UPDATE vocab_data SET n_txt = (SELECT count(DISTINCT %I::text) FROM public.%I), '
                 || 'n_upper = (SELECT count(*) FROM public.%I WHERE %I::text <> lower(%I::text)) '
                 || 'WHERE tbl = %L AND col = %L', ...);                            -- a second question
END IF;
```

and `str_type` declares, per base type, how many readings are owed and why — `text` → one ("a text column
compares exactly what it stores"), `citext` → two ("the type folds case, the ::text cast the details print does
not, so the gap between them is reported rather than smoothed over"). Two rows then answer for the type
instead of for the prose:

* **'the string census declares a reading for every type it catches'** — three refusals: a type the census
  caught with no reading declared, a reading declared for a type no column carries (a stale vocabulary
  surviving a schema change), and a reading name the census cannot take. Its detail prints measured counts
  only: `233 string column(s) over 2 base type(s), declared under 2 reading rule(s): citext 1 column(s), read
  two, text 232 column(s), read one — offenders: none`.
* **'a census that folds case reports both readings and which one the demo exercises'** — the pair must exist
  for every twice-read column, the two readings must **agree**, and no row may carry an uppercase letter. The
  second term is what makes the row worth having: it is the assertion the unique index enforces, re-checked
  from the data, and the first term refuses the silent `NULL` that would otherwise read as agreement.

D75's own row was renamed *a bounded **text** column is answered by name* → *a bounded **string** column is
answered by name*, since the window now spans 233 columns; the rename was checked in both directions (grep for
the old name: 0 hits; for the new: 1). 200 → 202 checks.

### 4. What the re-measurement did to this block's remembered prose

D73 removed remembered counts from census *detail text*; D78 found two still living in D75's *header*, and one
of them was simply wrong. Measured again on the from-scratch database:

* *"`n <= 12` alone catches 75 columns"* — the predicate catches **204** of 233. The number 75 could not be
  reproduced under any of four readings (`n<=12`, `1..12`, `2..12`, the full window) on **either** the fresh
  gate database (74 for `1..12`) or the drifted demo one (209 / 100 / 53 / 51). It was corrected to the
  measured figure, and the old one is named in the sentence so a reader who remembers it knows it was checked
  and lost.
* *"19 further columns carry 2..12 values below the row floor"* — now **20**, and the twentieth is
  `users.email` itself: widening the predicate moved a column into the set the header describes. The window
  stayed at 40 (5 rows is under the floor), which is the difference between a number that survived
  re-measurement and one that did not.
* *"Two columns answer 0 distinct values over their rows"* — true, and the sentence was silent about the other
  **128** zero-valued cells, which are zero because their **table** is empty (35 such tables, none populated
  by the shipped seed). Now said, because "the census has no exclusion list" is only honest if the census also
  reports what its numbers are made of.

This is the same failure mode as §71's, one layer up: a count written down next to a query goes stale when
either the query or the data moves, and prose is not exempt from the rule that a number must be re-read.

### 5. The plants, and what each one made red

Seven runs of the **shipped file**, sliced out of `data/seed/quality.sql` at `CREATE TEMP TABLE vocab_data`
(data plants, which the census must see) and at `CREATE TEMP TABLE str_type` (census plants, which mutate what
the census already measured), against a kept from-scratch gate database named on the drive's command line. The
drive prints the gate's own verdict and refuses to call a run green when psql exits without one.

| # | plant | rows red | what they said |
|---|---|---|---|
| W0 | none | — | 202 green; the three quoted rows print the details above |
| P1 | `DELETE FROM vocab_data WHERE btype <> 'text'` — D75's own predicate restored | both | `citext is declared but no column carries it — the census lost a type the vocabulary still answers for`; `0 column(s) measured twice: none` |
| P2 | `btype` rewritten to `varchar` on users.email — a second string type appears | both | row 1 names **both** offender kinds at once: `the census caught a varchar column (users.email) and no reading declares that type` and the now-stale citext term; row 2 loses its only twice-read column |
| P3 | one seeded address uppercased (data, pre-census) | row 2 | `users.email (5 row(s), 5 distinct under citext, 5 distinct under ::text, 1 row(s) carrying an uppercase letter)` — the readings still agree, so only the last term reddens: the demo has begun to exercise the difference |
| P4 | `n_txt`/`n_upper` blanked — the second reading never taken | row 2 | `users.email was never measured under citext, the pair is missing` — a missing measurement is not read as agreement |
| P5 | drop V4:44's index, then give the first user the last user's address folded to uppercase | row 2 | `citext sees 4 value(s) while the cast sees 5` **and** the uppercase term — the conjunct the index enforced from outside is now falsified from inside the data |
| final | none, over the restored database | — | 202 green; `users=5 distinct_citext=5 distinct_text=5 uppercase=0 uniq_index=1`, `P5 planted on demo.consumer@example.hk, restored to demo.consumer@example.hk -> VERBATIM` |

P1 is the plant that says *the widening is a defect fix*: the red is the schema's own shape reported by the
vocabulary that answers for it. P5 is the plant that keeps §"what is not claimed" honest — the agreement is
real but externally enforced, and removing the enforcement in a throwaway database makes the row say so, which
is the only way that conjunct can be shown to have teeth.

One false start belongs in the record, and it is a state bug rather than a gate bug. P5's first cleanup read
`UPDATE users SET email = lower(email)` across the whole table, which collapsed the case-variant pair into a
genuine duplicate address: `CREATE UNIQUE INDEX` then failed, the index was gone, and the drive's `final` run
printed **202 green over that damaged database** (`distinct_citext=4`, `uniq_index=0`). A green final run is
not a state proof. The restore now captures the planted row's original address and writes it back verbatim,
and the drive asserts `before == after` and the index's presence — which is why the line above reads
`VERBATIM`. An earlier false start was the row's own SQL: `string_agg(expr, ', ' FROM …)` closed the aggregate
after its `FROM`, so the statement died with `syntax error at or near "FROM"`. Under `ON_ERROR_STOP=0` psql
exits 3 and the file's hard gate never runs, which is INVALID rather than green, and the drive now distinguishes
the two.

### 6. What this does not claim

- The widening covers the `S` (string) category and domains resolved to their base type. `name`-category and
  composite types are still outside the census, as are columns added by ad-hoc DDL to the drifted demo
  database — which is why every number here was measured on a from-scratch one.
- `n_upper = 0` is *declared*, not measured, for plain `text` columns: the loop skips the query there. That is
  sound for the term row 2 asserts (a text column's two readings cannot diverge by case because neither folds
  it), and unsound if anyone later reads `n_upper` as "this column has no uppercase letters". Row 2 only reads
  it for `reads = 'two'` columns.
- The demo's agreement on `users.email` is an accident of lowercase seed data plus a unique index. If a future
  seed writes a mixed-case address, row 2 goes red by P3 and the fix is to answer for the divergence, not to
  delete the term.
- Nothing in this unit changed a line of Java, a migration, or a seeded value: the gate went 200 → 202 and the
  build did not move, so `mvn -o test` and `e2e_fresh.sh` were out of scope. The §109 question D76 raised is
  still undecided here, and the 35 empty tables this unit counted are the shape of that decision.

## D79 A probe over an empty table does not pass — it is not asked — 2026-09-25

### 1. The question nobody had asked about the probes

D65, D67, D68 and D71 built the polymorphic resolution machinery: a `<stem>_type` beside its `<stem>_id` is a
pair, the pairs are enumerated from `pg_attribute` (`poly_cat`), the types each may hold are declared
(`poly_arms`, 15 of them, copied by hand from what each probe's UNION actually reads), and each arm is resolved
against the table that type names. D71 then checked the arms against the vocabulary and against the schema. The
question left unasked is the one D74 and D75 learned to ask of every other check: **is there a row behind it?**

The probes are shaped

```sql
SELECT 'orphan: ' || …, count(*) FILTER (WHERE bad) = 0, … FROM g GROUP BY t;
```

so a type that ships no rows produces no group, and therefore no check. Measured on the kept from-scratch gate
database: `poly_arms` declares 15 arms, `qc` contains **9** rows named `orphan: …`, and the 9 are exactly the
arms the shipped dataset files rows under. Six arms are resolution rules this gate asserts over nothing:

```
facts.review  moderation_cases.merchant  moderation_cases.document  moderation_cases.message
permission_grants.user                   permission_grants.api_key
```

That is arithmetic, not taste: 15 declared, 9 emitted, 6 silent, and until this unit the ledger had no way to
name which six.

### 2. What the walk of the unprotected references said, and what it did not

The same seam was measured from the other side first, because "nobody walks these columns" is the kind of
sentence D66 wrote and D72 widened without testing. `ref_cat` enumerates the columns that look like references
and carry no FOREIGN KEY; `twin` asks a narrower question than a name guess — does *this schema* use that
column name on the child side of a real FK anywhere else:

```
SUM cols=26 inEmptyTables=19 carryingValues=6 withSchemaTwin=7 twinlessButPopulated=6
REF facts.subject_id             rows=5688 values=5688 twin=NONE     (probe, D65)
REF favorites.subject_id         rows=  18 values=  18 twin=NONE     (probe, D67)
REF moderation_cases.subject_id  rows= 544 values= 544 twin=NONE     (probe, D68)
REF permission_grants.subject_id rows=  36 values=  36 twin=NONE     (probe, D71)
REF permission_grants.granted_by rows=  36 values=  36 twin=NONE     (probe, D72)
REF user_identities.provider_id  rows=   5 values=   5 twin=NONE     (not-a-reference, D66)
```

Two things follow, and they point in opposite directions. The 6 columns that carry values are covered: each is
registered in `ref_registry` and resolved by a probe or explained. The 7 columns that DO have a schema-named
twin all sit in the 19 columns whose tables are empty by D64's fabrication guard, so walking them is a query
over zero rows — the vacuity is structural, produced by the same rule that keeps synthetic traffic out of the
demo. Nothing was invented here, and no new row was written about it: the finding is that the interesting half
of the reference seam is the polymorphic one, and its interesting failure mode is silence rather than error.

One candidate unit died at this measurement, and the record is that it died: the plan was to declare a target
per populated unprotected reference and walk them. The measurement showed the populated ones are already
registered, already probed, and that a name-based twin would have accused `user_identities.provider_id`
(`password/demo:admin`, an identity that lives outside this database by V4's design) of 5 dangling values. The
target the schema names for a column is not always the target the column means.

### 3. The change: the arms are counted against the data, and the silence is waived by name

`arm_seen` joins the declared arms to `poly_types` (the same census the probes group over) and left-joins a new
hand list `arm_idle(tbl, arm, writer, why)`. `writer` is the fact that makes each waiver re-checkable: `none`
means no code path in the build files that kind of row, `build` means the build does, the demo does not.

* **'an arm the seed never files is waived by name and by writer'** — four refusals. An arm the data never
  files and nobody waives (the six, before this unit existed). A waiver whose arm now carries rows — the
  exemption re-reads the data that justified it, exactly D77's rule for the view kinds, so filing a
  `review` fact withdraws `facts.review`'s waiver by itself. A waiver with a blank `why`, or a `writer` outside
  the two states this file knows. A waiver naming an arm no longer declared. Baseline detail:
  `15 declared arm(s): 9 exercised by the shipped seed, 6 idle and waived, 0 idle and unwaived`.
* **'every probe family resolves at least one armed type'** — a family whose rows all vanish resolves nothing.
  Its detail is the per-family sentence no other row prints:
  `facts ships 5688 row(s) across 3 of 4 arm(s), favorites ships 18 row(s) across 4 of 4 arm(s),
   moderation_cases ships 544 row(s) across 1 of 4 arm(s), permission_grants ships 36 row(s) across 1 of 3 arm(s)`.

### 4. Plants: eight runs of the shipped bytes, three seams

The drive slices the file at `INSERT INTO qc` (before every probe, for a data plant), at
`CREATE TEMP TABLE arm_seen` (after the hand waiver list) and at the new rows (after the ledger). Each run
prints the gate's own verdict, the number of `orphan: …` rows it emitted, and every red row in full.

| # | plant | red | measured effect |
|---|---|---|---|
| W0 | none | — | 204 checks, 9 orphan rows, both new rows green |
| A1 | `arm_seen` says `facts.review` carries 7 rows | row 1 | `10 exercised … 5 waived` — filing a review fact withdraws its own waiver |
| A2 | the `permission_grants.user` waiver deleted | row 1 | `… 5 waived` with the arm still idle: an unwaived silence |
| A3 | all four `favorites` arms forced to `n = 0` | rows 1+2 | `4 idle and unwaived` and `favorites ships 18 row(s) across 0 of 4 arm(s)` |
| A4 | `writer = 'maybe'` | row 1 | `facts.review (writer maybe)` — a waiver that names no state this file can check |
| A5 | `why = ''` | row 1 | an exemption with no reason |
| A6 | the `facts.review` waiver renamed to `facts.policy` | row 1 | both halves of the seam: `policy` is not a declared arm **and** `facts.review` is now idle and unwaived |
| A7 | **data plant, before the probes**: all 18 favourite rows deleted | 4 rows | **checks emitted 204 → 200, orphan rows 9 → 5**; red: D71's `an arm claimed seeded is a type the data still carries` (`unexercised: favorites.guide, favorites.merchant, favorites.collection, favorites.offering`), `favourites point at a renderable row` (`0 unreachable of 0 favourite(s)`), and both rows written here |
| final | none, restored database | — | 204 green, 9 orphan rows, `state after cleanup: favorites=18 by type=collection=1,guide=1,offering=4,merchant=12 \| stray d79 schema=0` |

A7 is the run the unit exists for. It is also the one that corrected this unit's own thesis on the way in: the
first attempt planted the same `DELETE` after the probes had already run, which produced a state no build can
reach (probes seeing 18 rows, the census seeing 0) and left the check count at 204 — a plant that quietly tests
nothing. Moved to the head seam, the four checks really do leave the ledger, which is the claim.

A7 also says what D79 does **not** add. A vanishing that touches a *claimed* arm was already covered twice over
(D71's row and the favourites row that predates this unit), so the family term is partly a restatement. What was
not covered, and is not covered by any plant here except in combination, is the unclaimed silence: six arms that
no vocabulary row claims and no probe emits, which is what row 1 and the waiver list exist to make sayable.

### 5. What this does not claim

- `poly_arms` is a hand copy of each probe's UNION arms — D71 names that residue and this unit inherits it. The
  ledger can only ask whether the *copy* is exercised; if a probe gains an arm and `poly_arms` does not, the
  check is asked and the arm stays invisible here, exactly as it did before.
- A waiver whose `writer` is `none` asserts a fact about the Java sources (no code path files such a row). The
  gate re-reads the *data* half of every waiver every run; the writer half is a file:line citation that rots
  with the code, and `writer = 'build'` on `permission_grants.user` is already a claim about a runtime path the
  demo never reaches.
- `arm_seen.n` is `poly_types.n`, which counts rows grouped by the type column. A row filed under an undeclared
  type still surfaces — as the orphan probe's own red, which is the older and stronger half of this seam.
- Nothing here changes the §109 traffic question, and no Java, migration or seeded value moved: 202 → 204
  checks, with the two new rows reading the same dataset the probes do.

## D80 The synthetic stamp lives in twelve columns; the row enforcing it read three — 2026-09-25

### 1. The claim worth testing in a D63-era row

The file has carried, since the seed's first provenance work, two hand lists about the §109 promise that
everything shipped says it is synthetic:

```sql
SELECT 'data_origin = demo everywhere the column exists', … merchants, reviews, collections          -- columns
SELECT 'jsonb data_origin marker (offerings/documents/chunks)', …                                    -- payloads
```

Six names, chosen when those were the columns that existed in the author's head. The question D80 asks is the
one D64 asked of its own fabrication guard and D74 of its door lists: **ask the data how big the set is.** A
promise about *every* synthetic thing is worth one row per place the thing is claimed, and no row yet counted
the places.

### 2. The measurement, before any edit

Every jsonb column of every base table, its rows opened with `jsonb_object_keys`, keys filtered on the shape a
provenance or synthetic marker has (`origin|synth|demo|generat`):

```
62 jsonb columns in `public`
  40 never filled at all — every one in a table D64's fabrication guard keeps EMPTY
  20 (column, key) pairs that claim an axis, across 12 columns:
       data_origin       12   chunks.metadata collections.seo documents.metadata facts.value
                             locations.geo_properties merchants.attributes merchants.contact
                             merchants.seo offerings.attributes resource_pools.attributes
                             reviews.moderation tenants.config
       synthetic          4   documents.metadata facts.value locations.geo_properties reviews.moderation
       demo               3   merchants.attributes offerings.attributes resource_pools.attributes
       demo_login_role    1   merchants.attributes
```

The row that is supposed to enforce the promise covers **3** of those 12 columns. The nine it does not include
`reviews.moderation` — the stamp on **all 11000 reviews**, the largest single home of the marker in the dataset —
`facts.value` on 5004 facts, `locations.geo_properties` on 684, and six more. Nothing about that was a decision;
the list was simply shorter than the schema.

### 3. The finding underneath: two axes wear one name

Inside `facts`, `data_origin` is not one thing across the schema. Measured pair by pair:

```
source=merchant | value->>'data_origin'=demo  2513     source=observed | demo   1800
source=merchant | (no key in the payload)      684     source=inferred | demo    171
                                                     source=demo     | demo    520
```

`facts.source` is §19's provenance — the four words this build writes — and `facts.value->>'data_origin'` is
§109's synthetic stamp, the literal `demo` on all 5004 rows that carry it. `generate.py` writes both in one
call: line 900 ends `"data_origin": "demo"}, None, None, "merchant", ttl_h=24*30`. So 4484 rows disagree
**correctly**, and 684 more (every `address`-shaped fact) keep the promise under the other spelling,
`synthetic: true` — which is also why a per-key universality term is wrong and a per-column one is right:
5004 + 684 = all 5688 rows stamped, no single key on all of them.

What was missing was not a fix but a statement. Nothing in the file said which name carries which axis, so a
consumer that answers "where did this price come from?" by reading the key inside the price payload gets `demo`
for every observed and merchant-supplied fact. `merchants.attributes.demo_login_role` = 'merchant' is the same
collision from the other side: it matches the marker pattern and is a login role, not a marker of either axis.
Also measured and **not** touched: `CollectionsRepository.java:68` tests `seo->>'generated_by'` against
('ai','editor','creator') while no jsonb payload in the shipped dataset carries a `generated_by` key at all (0
of 62 columns) — that read belongs to the §8 door's owner, so it is reported here and left alone.

### 4. The change: a census, a coverage count, and a declared axis per name

Three new structures, all read from the catalogue and the data rather than written out:

* `marker_cat` — one row per (column, key) the pattern finds in a filled jsonb column, with the column's row
  count, how many rows carry that key, and the distinct values it holds.
* `marker_cov` — one row per **column** that claims a stamp, counting rows carrying *any* of the answered stamp
  keys for that column. `facts.value` is stamped on 5688 of 5688 under this definition and on 5004 of 5688 under
  any single key's; the promise is about rows, and a column may keep it in more than one spelling.
* `marker_axis` — the hand list, and it has to stay hand-written: SQL cannot know that `demo` in a pool's
  attributes is the §109 stamp while `demo_login_role` in a merchant's attributes is a role. The catalogue
  decides who must be on it. Each answer carries `axis ∈ {synthetic-stamp, provenance, not-a-marker}` and a
  non-blank reason.

Three rows then read them: **'every jsonb key whose name claims an axis is answered for which axis it is'**
(census→answer and answer→census, a blank reason, an axis outside the three, and an answer for a key the
payloads no longer carry); **'the synthetic stamp says demo, or true, on every row of every column that carries
it'** (per-column coverage plus per-key value discipline — 19 stamped pairs over 12 columns, 46792 markers, each
column complete); and **'the §19 provenance axis and the §109 stamp axis stay separate on facts'**, which prints
the pair counts and refuses a stamp slot holding a provenance word. 204 → 207 checks.

### 5. Plants — nine runs of the shipped bytes, three seams

Sliced at `CREATE TEMP TABLE marker_cat` (data plants, which the census has not yet seen), at `DO $d80c$`
(mutate the key census after it ran but before coverage) and at the new rows (mutate the answer list). Each run
prints the number of checks emitted and the gate's own verdict, and every data plant restores the row it
touched and re-reads it afterwards.

| # | plant | red | what it said |
|---|---|---|---|
| W0 | none | — | 207 green; `20 (column, key) pair(s) measured across 12 jsonb column(s): data_origin=12, demo=3, demo_login_role=1, synthetic=4; 20 answered by the axis list, each by name — offenders: none` |
| P1 | one chunk gains a third spelling (`synthetic_data`) | row 1 | `the data carries chunks.metadata.synthetic_data (1 row(s), values true) and no axis answers for it` — the vocabulary outgrew the list |
| P2 | the census loses a key an answer still names | row 1 | `tenants.config.data_origin is answered as synthetic-stamp but the payloads no longer carry that key at all` — the exemption re-reads its own assumption |
| P3 | one review loses both spellings of the stamp | row 2 | `reviews.moderation is stamped on only 10999 of 11000 row(s): 1 row(s) carry no stamp key under any name` |
| P4 | one fact's stamp slot set to `merchant` — the wrong-way-round "fix" | rows 2 **and** 3 | `facts.value.data_origin carries value(s) demo,merchant, which is not the §109 stamp` and `a fact payload carries data_origin = merchant …`; the axes-disagree count stays 4484 while the stamp count drops to 5003 |
| P5 | an answer's axis renamed to `maybe` | row 1 | `facts.value.data_origin claims axis 'maybe', which is not one of the three this block knows` (both facts.value answers caught, one term) |
| P6 | an answer's reason blanked | row 1 | `the axis of reviews.moderation.data_origin carries no reason` |
| P7 | `facts.source = 'scraper'` on one row | row 3 | `facts.source = scraper is not a word this build writes` — and `source = merchant=3197, observed=1800, demo=520, inferred=171, scraper=1` shows the census noticing it in its own text |
| final | none, restored | — | 207 green; `reviews=11000 chunks=2118 facts=5688 merchants=520 tenants=1 unstamped_reviews=0 non_demo_stamps=0 d80_schema=0` |

P4 is the plant that justifies the unit's framing: a single row, edited the way a well-meaning maintainer would
edit it — "the payload should say where the value came from" — reddens the value discipline *and* the axis row,
and says in its own detail that the two axes still disagree on 4484 rows by design.

One false start belongs in the record, and it was the drive's bug rather than the gate's. The first P4 read
`UPDATE facts SET value = jsonb_set(f.value, …) FROM facts f WHERE f.id = (SELECT id FROM d80.snap)`, and in
Postgres the source of an `UPDATE … FROM` is not chained to the target unless the WHERE says so: the whole
5688-row table was written from one row's value, and the restore could not undo it. **The new rows caught the
damage** — the run after it printed six reds where zero were expected, which is the accident that proves the
terms read live data. The plant now names the target row directly, and each plant's cleanup is followed by a
probe that re-counts what it changed (`chunks with synthetic_data=0`, `unstamped=0`, `non_demo_stamps=0`,
`d80_schema=0`) rather than trusting the SQL to have worked.

### 6. What this does not claim

- The census pattern is `origin|synth|demo|generat`. A marker spelled without any of those substrings is
  invisible to it, which is why the near-miss is answered (`demo_login_role`, `not-a-marker`) instead of
  filtered out by narrowing the pattern: a narrower pattern does not make the next name miss louder.
- `rows` in the coverage count is the table's row count, not the count of object-valued rows. A jsonb column
  holding `[]` on every row would report 0 of N stamped — true, and today's array-shaped columns
  (`merchants.images`, `offerings.options`, `reviews.photos`, `collections.items`, `offerings.images`) carry no
  marker keys and so are not stamped columns at all.
- Which axis `data_origin` *should* carry inside a fact payload is a contract decision about the seed's output,
  and this unit takes none: it states the measured split, refuses the swap, and leaves `generate.py` untouched.
  If the product later wants provenance in the payload, row 3 reddens first and says why.
- No Java, migration or seeded value changed. 204 → 207 checks; `mvn -o test` and `e2e_fresh.sh` were not in
  scope, and the §109 question the marker exists to answer — is marked demo data acceptable traffic — is still
  the same undecided product call D64 and D76 recorded.

## D81 The arrays held the two most vocabulary-shaped columns in the demo, and no census could see them — 2026-09-25

### 1. What D78's fix still excluded

D78 replaced `atttypid = 'text'::regtype` with `pg_type.typcategory = 'S'`, and the sentence it corrected was
"every text column of every base table". That is now true of *strings*. It was never true of **strings inside a
container**: an array is category `A`, and a jsonb column is category `U`. So the two columns in this schema
whose value sets most look like vocabularies have been outside every census since the day the censuses started
— `merchants.tags` and `tenants.locales` — along with four object arrays whose shape no row compares.

The measurement, on the kept from-scratch database:

```
text[]      merchants.tags      520 merchants, 2428 elements, 100 distinct slugs,
                                rarest on 2 merchants, commonest on all 520
            tenants.locales       1 tenant,   3 elements,   3 distinct  (en, zh-CN, zh-HK)
            api_keys.scopes | campaigns.channel | eval_cases.tags | external_principals.scopes
                                                            0 rows each (D64 keeps these tables empty)
jsonb arrays  merchants.images    520 elements,  10 distinct, keysets=1 [alt, credit, url]
              offerings.images   5534 elements,  10 distinct, keysets=1 [alt, credit, url]
              offerings.options  4409 elements,   3 distinct, keysets=1 [name, values]
              collections.items    38 elements,  25 distinct, keysets=1 [note, subject_id, subject_type]
              reviews.photos        0 elements on all 11000 rows — every review carries an empty array
```

`merchants.tags` passes §71's own definition of a vocabulary — a value set that REPEATS (24.3 occurrences per
value; not one value appears on a single merchant). And it is the one facet the SEO directory filters on:
`SeoRepository.java:151` runs `:tag = any(coalesce(m.tags,'{}'::text[]))`, while the door in front of it
validates only `SLUG_PATTERN` (`SeoRepository.java:50`) — a *shape* rule, not a list. So the 100 values are
bounded by nothing anywhere: not the schema, not a door, not a check.

`tenants.locales` is the mirror case. It is bounded — by a column DEFAULT, `ARRAY['en','zh-HK','zh-CN']` from
V1:21 — and the one seeded tenant happens to match it. A bound that lives in `pg_attrdef` is a real bound, and
nothing in the file was reading it.

### 2. The change: a census of elements, an answer per column, and the DEFAULT read back

`arr_cat` measures every `text[]` column and every jsonb column that actually holds arrays: rows, rows with
elements, elements, distinct elements, and — for object elements — the number of DISTINCT key signatures plus
their union. `arr_bound` is the hand answer per column, and its `kind` is one of four states:

* `nothing-bounds-it` — allowed only while the catalog offers no bound: the row checks that the column really
  has no `ARRAY` DEFAULT, so if someone adds one to `merchants.tags`, the answer that said "nothing bounds
  this" reddens by itself.
* `column-default` — the strong kind. The answer names the elements the bound allows, and the row compares them
  both against the distinct elements the data carries (a count match, plain SQL) and against the DEFAULT text
  read from `pg_attrdef` (every declared element must still appear in it). Three separate facts have to hold
  for one green.
* `payload-shape` — for object arrays, where the contract is the key set, not the values.
* `never-populated` — an assertion that the column carries no elements anywhere, which is what makes
  `reviews.photos`' 11000 empty arrays a stated fact rather than an accident.

Three rows: **'every array column is answered for what bounds its elements'** (census↔answers both ways, a
non-blank reason, a known kind, and the two `column-default`/`nothing-bounds-it` catalog terms);
**'the elements of an object-array column all carry the same keys'** (`keysets > 1` reddens, and an answer's kind
must agree with whether the column has elements at all); and **'a text[] value that appears on exactly one row is
named, not averaged'** — §71's row floor applied to elements, so `merchants.tags` is allowed to be a vocabulary
(rarest 2) and a value on a single merchant is called out by name. 207 → 210 checks.

### 3. Plants — nine runs, three seams, and two of them data plants

| # | plant | red | what it said |
|---|---|---|---|
| W0 | none | — | 210 green; the three rows print the census above verbatim |
| Q1 | the `merchants.tags` answer deleted | RA | an array column with 2428 elements and no answer for what bounds it |
| Q2 | its kind set to `free-text` | RA | `the answer for merchants.tags names kind 'free-text', not one of the four this block knows` |
| Q3 | the declared DEFAULT set gains `und` | RA | declared 4 against 3 in the data — and the same element is missing from the catalog's DEFAULT, so both `column-default` terms fire on one plant |
| Q4 | `tenants.locales` answered `nothing-bounds-it` | RA | `is answered nothing-bounds-it but now carries a DEFAULT of ARRAY['en'::text, …]` — the catalog refutes the answer |
| Q5 | `merchants.tags` answered `never-populated` | RB | the element count contradicts the kind |
| Q6 | one image element gains a `caption` key | RB | `merchants.images keysets=2` where 6053 other objects carry three |
| Q7 | one merchant carries a tag nobody else has | RC | `the rarest element of merchants.tags is on 1 row` |
| final | none, restored | — | 210 green; `merchants=520 with a 1-row tag=0`, `merchants with a caption key=0`, no `d81` schema left |

Q6 and Q7 are the plants that matter: they change shipped data, not the answer list, and each restores the row
it touched from a snapshot table created in a schema the gate does not scan — then re-counts, because D78 taught
this lane that a green final run is not a state proof.

### 4. What this does not claim

- `nothing-bounds-it` for `merchants.tags` states where the values come from (`generate.py`'s word lists) and
  that no door enumerates them. Whether the SEO grammar **should** carry a controlled facet list is a product
  decision about another stream's door; this unit makes the absence readable and takes no position on it.
- A count match is not a set match: `column-default` compares the *number* of distinct elements against the
  number declared, plus each declared element's presence in the DEFAULT text. A data value substituted for
  another (zh-HK → zh-TW, same count) would slip through the first term and be caught by the second only if it
  removed a declared element. Stated rather than smoothed over; a full set equality over two dynamic sources was
  the part of this block that kept reading worse than it worked.
- `arr_cat` looks at `text[]` and jsonb only. No other array type is shipped — measured through
  `pg_type.typcategory = 'A'` in the same database — and composite types (category `C`) are absent, so the
  container blind spot is now bounded by a measurement rather than by luck.
- `keysets = 1` is a statement about elements that are objects. `reviews.photos` reports `keysets=0` because it
  has no elements at all, which is what its `never-populated` answer claims; if it ever gains one, the kind
  reddens before the shape does.
- No Java, migration or seeded value changed: 207 → 210 checks, and `mvn -o test` / `e2e_fresh.sh` stay out of
  scope for a unit the gate reads from disk.

## D82 Four booleans claim a verification the schema cannot evidence, and two of them are served to users — 2026-09-25

### 1. What the boolean plane turned out to be

§81 left a clean negative that this unit starts from: of the 12 boolean columns in the schema (9 in populated
tables) none is degenerate — none is never-true or always-true. So there was no bug to find in booleans as a
type. What there was, is what their *names* promise. Four columns assert that something happened somewhere
else, and §19 requires such a claim to carry a source:

```
reviews.verified_purchase       true on  2456 of 11000 rows
reviews.verified_reservation    true on  1289 of 11000 rows        (300 rows carry both)
merchants.ownership_verified    true on   193 of   520 rows
users.marketing_opt_in          true on     1 of     5 rows
```

3745 flags over 3445 distinct reviews. And the tables that would hold their evidence — `orders`, `payments`,
`reservations`, `carts` — are at 0 rows each, because D64's fabrication guard requires them empty and
`seed_truncate_probe.sh` proves that guard is live. `reviews` has no column that could name an order or a
reservation either: the only column matching `%reservation%` on that table is the flag itself. So the badge is
not merely unevidenced in today's data, it is **structurally unresolvable** — no reservation could ever be
pointed at.

### 2. Why this is not just a seed curiosity

The flags leave the database. `CatalogController.java:391-397` puts both booleans into the consumer payload and
derives `"verified_visit": verified_purchase || verified_reservation`; `:441-442` publish
`verified_purchase_reviews` and `verified_reservation_reviews` as merchant-facing statistics;
`AdminListRepository.java:126` carries both into the admin view. A badge rendered to a user is the strongest form
of the claim, which is why the gate — which already asserts things like "every rendered rating is backed by a
fact" — should not be silent about a badge backed by nothing.

Two readings remain open, and this unit picks neither. Either the flags are demo decoration, which is exactly
what §109's ban on fabricated engagement is about; or `verified_*` is a provenance marker being rendered as a
trust signal, which is a §19 mistake in the presentation layer. Deciding means changing `generate.py` or the
consumer payload, both owned elsewhere. What the gate can say, and now does, is that the badge cannot be traced,
and that it must stop being able to say so the day tracing becomes possible.

### 3. The change: an answer per flag, and a state the data re-derives

* `badge_cat` — every boolean whose name claims a verification or a consent (`verif|opt_in|consent|ownership`),
  with rows, flagged rows, and the word a key column would have to carry (`verified_purchase → purchase`,
  `ownership_verified → ownership`).
* `badge_answer` — the hand list, because SQL cannot know that `verified_purchase` is about `orders`. Each answer
  names an evidence table (or `-`), a state in {`never-resolvable`, `no-evidence-table`, `resolved`,
  `unresolved`}, and a non-blank reason.
* `badge_state` — per answered flag, the two facts the answer depends on, read from the database each run: how
  many rows the named evidence table holds, and how many **non-boolean** columns of the flagged table carry the
  key word. Excluding booleans is what stops `verified_reservation` counting as a path to `reservations`.
* `badge_live` — a view that **recomputes** the implied state from those two numbers. That view is the second
  version of this row: the first compared `state` to a stored `implied` column, i.e. two of the check's own
  columns, and the plants found it unfailable. A check that compares its own memory to its own memory is not a
  check.

Two rows: **'every boolean that claims a verification is answered for its evidence'** (census↔answers both ways,
non-blank reason, a state from the four known, and a named evidence table that the catalog still has) and
**'a verification badge stays unresolvable only while its evidence and its link both stay absent'** (the answered
state must equal the recomputed one, so `never-resolvable` survives only while evidence rows = 0 **and**
link columns = 0). 210 → 212 checks.

### 4. Plants — nine runs, and the one that exposed the first version of the row

| # | plant | red |
|---|---|---|
| W0 | none | 212 green |
| B1 | the purchase-badge answer deleted | RA — and note RB stayed green: three remaining `never-resolvable` answers still satisfy its non-vacuity term |
| B2 | an answer's state set to `probably-fine` | RA **and** RB, because an unknown state is also a mismatch |
| B3 | an answer's reason blanked | RA |
| B4 | the purchase answer says `resolved` while nothing is reachable | RB |
| B5 | the census's evidence-row count moved to 520 | RB — the recomputed state, not the stored one, is what reddens |
| B6 | `ALTER TABLE reviews ADD COLUMN order_id uuid` before the censuses | RB — the link column that would make the badge a checkable claim |
| B7 | `users.verified_identity boolean DEFAULT true` added | RA — a fifth flag with no answer |
| final | none, both DDL plants reverted | 212 green, `link-shaped non-boolean columns on reviews=0`, `users.verified_identity=0` |

B6 and B7 are DDL against a throwaway gate database and are reverted by the same script that applied them, then
re-counted — the rule §78 and §81 both had to learn the hard way.

### 5. What this does not claim

- The row does not decide what the badge means. It records, per flag, which axis the answer claims and whether
  the database could confirm it, and it reddens on the two ways that could change.
- `no-evidence-table` for `ownership_verified` and `marketing_opt_in` rests on a schema reading (no table or
  column holds the event) plus the §5 note that ownership is a status the verification door moves. The status
  transitions themselves are §17's unfinished work, not this row's.
- The pattern `verif|opt_in|consent|ownership` is the definition of the set, so a flag named something else —
  `has_receipt`, `trusted_reviewer` — is invisible to it. The pattern is stated so the next reader can widen it
  deliberately rather than discover the gap by accident.
- Nothing here changes `generate.py`, the consumer payload or the admin view: 210 → 212 checks, and the §109/§19
  decision is filed as task #56's open question for the streams that own those files.

## D83 76 numeric and timestamp columns, 24 of which cannot vary, and one that varies with the wall clock — 2026-09-25

### 1. What the census found

§75 counted distinct values for strings, §81 for array elements, §82 for booleans. The numeric/date/timestamp
plane had never been counted. Measured on the kept from-scratch database, of 76 columns in categories N/D/T
(uuid excluded):

* **4 are NULL on every row** — `chunks.embedded_at` (2118 rows), `moderation_cases.resolved_at` (544),
  `permission_grants.expires_at` (36), `users.deleted_at` (5). Each is a promise the demo does not keep: no
  embedding is recorded, no case in the queue is resolved, no grant ever expires (§43's finding), no user is
  deleted.
* **20 hold a single value** — 18 fully populated and 2 with the value only on part of the rows
  (`offerings.min_party_size` = 1 on exactly the 804 bookable offerings, `offerings.stock_updated_at` on 232
  of 5534).
* **0 corrupt** — every range and ordering rule came back clean: no review older than its edit, no fact
  expiring before it was observed, no merchant updated before created, no negative price, no slot booked beyond
  capacity. The `CONSTANT` list is not a bug list; it is a list of columns that cannot discriminate.

One of them is different in kind. `facts.updated_at` holds the load instant (measured `2026-09-25 10:39:53`
while the seed's pinned base date is `2026-09-22 11:00`) because V6 added that column
`NOT NULL DEFAULT now()` to satisfy the V1 `set_updated_at()` trigger that had been assigning a field `facts`
did not have. Its COMMENT promises "when this claim was last restated", so a freshly seeded demo reports all
5688 of its claims as restated at load time — and the value differs between two runs of the same seed. Every
other constant is the pinned instant or a deliberate backdate.

### 2. The change

`spread_cat` classifies each such column (`all-null`, `constant`, `sparse-constant`, `varying`) with rows,
nulls, distinct values and the single value itself; `spread_answer` is the hand list naming the kind of each
degenerate column — `never-written`, `all-open-queue`, `uniform-by-design`, `single-instant-pinned`,
`history-date`, `generation-clock` — with a reason; `spread_clock` is a view that derives, from the data, which
answered columns really do sit within ten minutes of `now()`. Two rows then read them:

* **'every column that cannot vary is answered for why it cannot'** — census↔answers both directions, a known
  kind, a non-blank reason, and the staleness term: an answer whose column has started varying is refused.
* **'the columns stamped from the generation clock are exactly the ones answered so'** — both directions of the
  clock set: an unanswer column holding a load-time value reddens, and so does an answer left behind after the
  value stops being the clock.

214 checks, `RESULT: PASS — 214 quality checks on a from-scratch schema (tables=58, migrations=7)`.

### 3. Plants, and what is and is not falsified

Nine runs at three seams, `W0` and `final` green at 214. Proven, on a freshly built database:

* **C4** — `spread_cat` says `offerings.min_party_size` now holds 2 distinct values → row 1 red: the exemption
  re-reads its own data. (This term was also caught by real data, before the plant was written correctly: an
  `UPDATE offerings SET min_party_size = 2` moved `offerings.updated_at` as well, because V1:961-970 installs
  `set_updated_at()` as a BEFORE UPDATE trigger on every table with that column, so the census found
  `offerings.updated_at` varying and refused its `single-instant-pinned` answer. A plant that reaches a column
  under audit through a trigger is a plant that cannot be undone: the census copy is mutated now, never the
  rows.)
* **C6** — `facts.updated_at` pinned to the base date while the answer still says `generation-clock` → row 2
  red, with the offender naming the column and its value.
* **C7** — `ALTER TABLE merchants ADD COLUMN dormant_years smallint` (NULL on all rows, no answer) → row 1 red.

**Not yet shown able to fail** — and this is the residue, not a claim: the unknown-kind term, the blank-reason
term, the "answer deleted" direction of the coverage term, and row 2's clock-growth direction. The runs that
were supposed to cover them aborted on a drive-side bug (a mutation injected at a seam before the hand list
existed, and a python escape that put a newline inside a string literal), so the drive reported `checks emitted:
0` — INVALID, never counted as a pass, and still open. They are the first work of the next session on this row,
and none of them should be believed until it reddens on purpose.

### 4. What this does not claim

* Naming `facts.updated_at` the load instant does not say the seed is wrong. V6 documents why the column exists
  and what it means; the row only refuses to let a per-run-varying value in a supposedly pinned demo be invisible.
  Whether to pin it, or to accept the drift and say so, is a decision about the seed that this unit leaves alone.
* The `min_party_size` answer is `uniform-by-design`, not "wrong": 804 bookable offerings with one party size is
  a data choice. The value of the row is that a facet which cannot discriminate is now stated, so a filter built
  on it is understood before someone is surprised by it.
* `spread_cat` reads the same `pg_attribute` catalogue as §75/§78's censuses, so a column in a table the seed
  never fills is skipped (`CONTINUE WHEN n = 0`), which is what D64's guard makes normal and §75's window makes
  explicit: no claim is made about a column with no rows to look at.
* No Java, migration or seeded value changed. 212 → 214 checks; `mvn -o test` and `e2e_fresh.sh` stay out of
  scope for a file the gate reads from disk.
