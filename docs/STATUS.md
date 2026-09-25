# NEXUS build status & verification ledger

Maintained by the lead agent. A line moves to `verified` only when the quoted command has been run and
its output seen. Nothing here is aspirational.

As of last update: **no work stream is finished, but the shape changed.** Infra (except the Postgres name
collision, D22), SDK, docs, types, UI-kit and the consumer-web vertical slice are working; the platform's test
suite is green; the AI service's HTTP layer is green offline **and**, for the first time, against the seeded
database (D23). The seed is loaded and gated at 150 checks. Two streams are writing `/merchant` + `/admin`
and the SEO read surface right now.

## Running services (re-measured with `docker ps` + queries, 2026-09-22 03:30 — see D22)

| What | Where | State |
|---|---|---|
| Postgres 16 + pgvector **for this repo** | container `nexus-platform-testpg`, `127.0.0.1:5433` | running, **manually provisioned by the platform stream, not compose-managed**. DBs: `nexus` (the seeded demo tenant — see the row below) and `nexus_test` (58 public tables, roles `nexus_app` + `nexus_ai` from `V1`/`V2`/`00_roles.sql`). |
| Seed dataset | `nexus` DB on 5433, loaded by `data/seed/load.sh` with `RESEED_DEPENDENTS=1` | **loaded and gated** (re-measured 2026-09-22): tenants 1 / merchants 520 / offerings 5534 / reviews 11000 / documents 1040 / chunks 2118 / facts 3961 / availability_slots 32492 / review_summaries 0. `data/seed/quality.sql` → **all 150 checks passed**, exit 0. |
| `nexus-postgres` (55433) | belongs to **another project** (`D:\内容创作平台\infra`), superuser `nexus`, 29 unrelated tables | NOT OURS. It squats the container name our compose file used to pin (D22). Never touch it. |
| throwaway verify DB | container `nexus-seed-verify`, `127.0.0.1:55432` | running; user `nexus`, DB `nexus`, **0 public tables** — a clean sandbox, nothing was ever loaded into it |
| Redis 7 | container `nexus-redis`, `127.0.0.1:6380` | running (healthy) — the only store our compose file has ever started successfully |
| Platform :8080 | **another project** (`java -jar target/career-os-backend-0.1.0.jar`, confirmed via `Get-CimInstance Win32_Process`) | NOT OURS. Our platform runs on `NEXUS_PORT=8090` locally (D22 §7); `application.yml` keeps 8080 as the contract/CI default. |
| AI :8000 | **another project** (`python -m uvicorn app.main:app --port 8000`) | NOT OURS. Same substitution: `--port 8010` locally (D22 §7). |
| Web (prod, mock data plane) | `next start -p 3002`, log `/tmp/nexus-prod.log` | running; :3000 belongs to another project and :3001 is the dev port — never kill or bind 3000 |

The previous revision of this table asserted "Postgres … container `nexus-postgres`, `127.0.0.1:5433`,
`nexus` DB has 59 tables". That was measured against a container that is no longer on this machine, and the
name has since been taken by a different project — so it was wrong in two directions at once. Ports and
container names in this file must carry a re-measurement date (D22 §5).

Ports are fixed by `docs/DECISIONS.md` §D9 because this machine already runs unrelated stacks on 5432/6379
(`careeros-postgres`, `specproof-*`). Do not bind those.

## M0 contracts

| Artifact | State | Evidence |
|---|---|---|
| `infra/db/migrations/V1__init.sql` + `V2__integrity.sql` | committed `7591852`, applied to `nexus_test` on 127.0.0.1:5433 today | 58 public tables, `ON_ERROR_STOP=1`, roles `nexus_app`/`nexus_ai` connect (platform stream, 03:15). **The older "`nexus` DB has 59 tables" row is retracted** — that container is gone and the name is now another project's (D22). |
| `docs/API_CONTRACT.md` | in tree, §0.1 BFF surface + §8 SEO reads + §11 telemetry added this pass | consumed by platform/ai/web/sdk/e2e |
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

## CI pipeline state (2026-09-22)

`.github/workflows/ci.yml` runs lint-type → platform → ai → e2e, plus `contract-drift` (new, report mode) and
`security` (gitleaks hard-fail per §131), and `required` gates on all six.

Two defects found by actually parsing the file rather than reading it:

1. **The workflow could not be parsed by GitHub at all.** `docs/STATUS.md` line 124's step name contained an
   unquoted `: `, which is a YAML `ScannerError` ("mapping values are not allowed here, line 124 column 38").
   Every job in it would have failed before running a single step. Fixed by quoting that one scalar; verified
   with `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` →
   `OK jobs: [changes, lint-type, platform, ai, e2e, contract-drift, security, required]`.
   Lesson written down because it generalises: an unverified YAML/JSON config is a claim, not an artifact —
   parse it or say it is unverified (§156).
2. `npm ci` is missing from the `contract-drift` job… it does not need it (the checker is dependency-free
   Node), which is why it runs `node scripts/check_contract_drift.mjs` directly after `setup-node`.

Still true: **no CI job has ever run.** The repo has 4 commits and **no remote** (`git remote -v` is empty), so
GitHub Actions has never been triggered by anything. Every statement above is about the file's content and a
local YAML parse, not about a green pipeline.

## Route coverage ledger (machine-generated, not opinion)

`node scripts/check_contract_drift.mjs` parses every path in `docs/API_CONTRACT.md`, then looks for it in
the real implementations. **GitHub Actions runs it in report mode on every push** (`contract-drift` job in
`.github/workflows/ci.yml`, output attached to the run summary); it flips to a hard gate at M4 (§156). Last
full run (lead, 2026-09-22 06:20, after the §4 reads landed — the AI stream is still adding `/ai/v1/**`
handlers, so the counts move):

| Bucket | Count | Meaning |
|---|---|---|
| Documented routes parsed | 99 | every row of §3-§11 plus the §0.1 BFF surface |
| Served by platform/ai | 63 | a handler exists in `services/platform` or `apps/ai` (was 45; +6 from §4, the rest from the growth/SEO/referral and AI streams) |
| **CLIENT-ONLY** | 32 | SDK/web calls it, no service answers — a working-looking button that 404s |
| **MISSING** | 0 | was 4 — the referral and merchant-customer family is now built |
| **UNDOCUMENTED** | 0 | was 5 → 3 → 0: `GET /ai/v1/conversations/{id}` and `GET /ai/v1/health` are now documented in §7 with the payloads the running service actually returns |

Closed this pass:

- The web BFF's own paths (`/api/nexus/ai/{search,stream,compare}`, `/api/nexus/platform/**`) are now a
  documented surface of their own — **API_CONTRACT §0.1** — and `documentedProxies()` in the checker knows a
  proxy is a proxy: it is matched in the reverse direction only, because searching the services for
  `/api/nexus/ai/stream` would report a false CLIENT-ONLY row for a route that is supposed to be forwarded.
  A guard against the obvious mistake is in `toMatcher`: `**` is expanded to a mount **inside**
  `documentedProxies()` only. Widening it globally was tried first and it made the contract's topology row
  `` `/api/v1/**` `` swallow every documented path, so the "undocumented" check silently found nothing
  (`/api/v1/events` stopped being reported). Measured, reverted, re-measured.
- `POST /api/v1/events` (§58 telemetry batch the SDK has always called) is now documented in §11 with its
  honest limits — append-only, idempotent per batch, never a write path for anything a user sees, never an
  input to organic ranking (§66). It moved from UNDOCUMENTED to CLIENT-ONLY, which is the true state: no
  service implements it. Owner: platform stream.

The 4 MISSING closed this wave: `/api/v1/referrals/invite`, `/api/v1/referrals/me`,
`/api/v1/referrals/me/stats` (§61-62 growth) and `/api/v1/merchant/customers` (§23/§56) are now served by
`com.nexus.growth` and the merchant workspace. `POST /api/v1/events` is served too. What is left of the
platform's M1 backlog is the 32 CLIENT-ONLY rows: the admin console (§9), commerce carts/orders/payments
(§6), guides and collections (§8 reads), and the merchant-side campaign/import/knowledge-base/member routes.

## Stream states (re-measured 2026-09-22 03:30; previous revision was a turn-ceiling snapshot)

| Stream | State on disk, measured | Verified by |
|---|---|---|
| platform | 76 main sources, `mvn -o test` → **Tests run: 22, Failures: 0, Errors: 0 — BUILD SUCCESS**, with `git status services/platform` empty. The 17-of-22 failures this row carried an hour ago were never four bug families: all of them were `ApplicationContext` load failures against a Postgres that did not exist (D22). Provisioning `127.0.0.1:5433` from the unmodified `V1`/`V2`/`00_roles.sql` fixed every one, and no production code or test expectation changed. | lead re-ran the suite, 03:27 |
| ai-service | 29 modules of config/contract/nlu/search SQL, **no HTTP router yet** — `/ai/v1/search` and `/ai/v1/search/stream` are still CLIENT-ONLY in the drift ledger. Being built now. | drift scan 03:20 |
| consumer web | 18 routes (`/`, `/search`, `/m/{slug}`, `/o/{slug}`, `/{city}[/category[/facet]]`, `/guides*`, `/collections*`, `/robots.txt`, `/sitemap.xml`, BFF under `/api/nexus/**`), 27 unit tests green, `tsc` clean, prod build serving on :3002 in mock mode | lead, this section + the SEO table above |
| consoles | `/merchant` + `/admin` not on disk yet; another stream is writing them now | — |
| db / seed | still **0 rows** in every candidate container: `nexus_test` has schema only, `nexus-seed-verify` has 0 public tables, and no `nexus` DB exists on 5433. A stream is loading it now. | `docker exec … count(*)` 03:25 |

Consequence for the plan: the vertical slice (§166-168) still cannot be closed end-to-end, but the blockers
narrowed to two — the AI service's HTTP layer and a seeded database. The consumer web is no longer one of them:
it runs, it degrades honestly, and it is the reference every other stream can integrate against.


## Definition of done for the vertical slice (§170)

`make dev-stack` then `npm test` in `tests/e2e` green, with screenshots of `/`, `/search`, `/m/[slug]`,
`/merchant`, `/admin` in `tests/evidence/`, plus one eval run report showing hallucination rate < 2%.

**Half of that is not achievable on this machine right now:** the in-app browser reports
`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`, so no screenshot evidence can be produced by any agent here. The
substitute is a machine-checkable HTTP walk (next section); it is stated as a substitute, not as the
§170 gate satisfied.

## The consumer slice, walked end to end over HTTP (2026-09-22, task #18)

`scripts/verify_consumer_slice.py` is the repeatable gate: it walks directory → AI search → merchant page
→ reservation → readback and prints one verdict per assertion (`13 passed, 0 blocked, 0 failed` on the run
that wrote this line). It composes two deeper legs, each runnable on its own:
`scripts/verify_merchant_page.py` (20 assertions on the rendered HTML of `/m/basil-still-0014`) and
`scripts/verify_reservation.py` (12 assertions on the booking write). It starts nothing and stops nothing;
a service that is not answering is reported `BLOCKED`, never marked green.

What the walk asserts, because those are the four ways this slice can lie:

- **§19 on the listing** — every printed price has a `price` fact, every `open.source_fact_id` names one of
  that same card's facts (8/8 after D25), an expired fact arrives with `stale` set, and `X-Demo-Data` is on
  the response.
- **§18 on the AI path** — all 15 `ai_match.reasons[]` bullets carry a `fact_id` that resolves to a fact on
  the card they decorate (`missing=[] dangling=[]`), with `strategy=hybrid_v1+postgres+vector` and
  `degraded=false` stated rather than assumed. `provider=mock, offline=true` is reported as-is: no LLM key
  is configured, and the walk does not pretend otherwise.
- **§20 on the seat** — availability is `no-store` while listings are `s-maxage=300`.
- **The booking itself** — `POST /api/v1/reservations` now exists (`ReservationController` +
  `ReservationService` + `ReservationRepository`, 8 tests in `ReservationApiTest`, suite **70/70**). The slot
  decides the terms: `starts_at`, `ends_at` and `total_amount` are copied from the `availability_slots` row
  and a client that sends none of them still cannot name its own time or price. Capacity is claimed by an
  `update … where capacity_left >= :party_size` inside one transaction, so a double-tapped confirm replays
  the same `NX-RES-…` code at 200 instead of taking a second table (observed live on the second run of the
  walk: `5 -> 3`, then `3 -> 3`, one row). `status` stays `pending` because nothing here may claim a merchant
  accepted. Contact is an allowlist (`name`/`phone`/`email`), so a `card_number` field in the request body is
  dropped rather than stored (§42). Cross-tenant slot → `404 slot_not_found`, draft merchant → `404
  merchant_not_found`, no channel to confirm by → `422`, full slot → `409 slot_full` with capacity unchanged,
  anonymous → `401`.

The walk's two runs left one demo booking in the developer database (`NX-RES-A5DMBX`, slot
`0fe208f0-dd2a-508f-b0f9-fa79a9ecd7fd`, merchant `basil-leaf-0419`, 2 seats taken out of 5). There is no
cancel route yet, so it is recorded here rather than hidden; a cancel/retrieve surface is part of task #17.

## SEO discovery surface (2026-09-22)

`app/robots.ts` + `app/sitemap.ts` serve the §29 crawl contract for every public page. Discovery is closed
by default behind a new server-only knob `SEO_DISCOVERY_ENABLED` (`NEXUS_SEO_DISCOVERY_ENABLED`, default
`false`, deliberately not in `publicEnv`), because §27 treats publishing to search engines as a human
action; the pure selection logic lives in `src/lib/seo.ts` and is covered by `src/lib/seo.test.ts`. Flag off
(verified on a throwaway dev server): `/robots.txt` answers 200 `Disallow: /` with no `sitemap:` line, and
`/sitemap.xml` answers 404 via `notFound()`. Flag on: robots advertises the sitemap and disallows `/search`
+ `/api/`, and the sitemap emits only `/`, `/m/{slug}`, `/o/{slug}`, `/{city}[/category[/facet]]`,
`/guides*` and `/collections*`, with each programmatic page gated by the §30 `indexable` bar (in the seed
that admits `/hong-kong` and `/hong-kong/restaurants` and nothing thinner), `lastModified` sourced only from
a real `updated_at`/`published_at`, and every URL built from `SITE_URL`. `npx tsc --noEmit` is clean for
these files.

## Consumer web: programmatic SEO + growth surface (2026-09-22, verified on the prod build)

The §29 URL grammar and the §30 quality bar are now implemented end to end, and the navigation reaches them.

| Layer | Files | What it guarantees |
|---|---|---|
| Pure grammar + numbers | `src/lib/directory.ts`, `src/lib/directory.test.ts` (10 tests) | `/{city}`, `/{city}/{category}`, `/{city}/{category}/{facet}` built from slugs only; `facetsOf` re-derives every count from the cards actually rendered, so a page cannot state a number its own list contradicts (§19); `labelFor` falls back to the raw slug rather than inventing a translation |
| Server resolver | `src/lib/directory-server.ts` | Returns `null` outside the grammar (→ `notFound()`), derives `robots` index/follow from `page.indexable`, drops zero-listing categories from the city landing |
| Views | `src/components/directory-view.tsx`, `growth-view.tsx`, `locale-badges.tsx`, `json-ld.tsx` | Visible thin-page warning when `!indexable`, AI disclosure on guides, `CollectionPage`+`ItemList` JSON-LD with **no** `aggregateRating` |
| Routes | `app/[city]/page.tsx`, `app/[city]/[category]/page.tsx`, `app/[city]/[category]/[facet]/page.tsx`, `app/guides/page.tsx`, `app/guides/[slug]/page.tsx`, `app/collections/page.tsx`, `app/collections/[slug]/page.tsx` | Unreviewed AI guides stay `noindex` and out of the sitemap until a human approves (§27/§30) |
| Navigation | `src/components/site-chrome.tsx` | Header + footer link `/{city}`, `/guides`, `/collections`, `/search` |

Measured on `next start` :3002 (fresh build, mock data plane; `tsc` clean, 27 unit tests pass, build ✓ 7/7 static
pages, **0** `⨯` lines in the server log):

```
200 /hong-kong              香港的真實商家與服務          index, follow
200 /hong-kong/restaurants  香港餐廳                    index, follow   (8 distinct /m/ links, 2 ld+json blocks)
200 /hong-kong/shopping     香港購物                    noindex, follow (§30 thin-page notice visible)
200 /guides · /collections                             index, follow, no degrade notice in mock mode
200 /guides/rainy-day-hong-kong                        noindex, follow + "尚未經人工審核" + "本文由 AI 生成"
404 /hong-kong/restaurants/nope-facet · /hong-kong/nonsense · /nonsense-city
404 /m/does-not-exist · /o/nope-xyz   (hard 404 — see the no-`loading.tsx` rule below)
404 /sitemap.xml  (SEO_DISCOVERY_ENABLED=false)  ·  200 /robots.txt → "User-Agent: *\nDisallow: /"
```

Two rules this pass established, both recorded where the next engineer will hit them:

1. **No `apps/web/app/loading.tsx`.** A root-segment loading file creates a Suspense boundary that flushes the
   document shell at HTTP 200 before a dynamic segment can call `notFound()` — measured: with the file present
   `/m/does-not-exist` answers 200, without it 404. Route skeletons belong inside a segment below the decision.
2. **§155 nav rule.** The chrome advertises only URLs it knows it can answer. `/guides` and `/collections` are
   always safe because their list reads degrade to an honest empty state plus a visible notice
   (`guideList`/`collectionList` now return `degraded(pageOf([]))` rather than throwing); the `/{city}` directory
   is linked only while its data plane can answer. `directoryLink()` in `site-chrome.tsx` is the single place to
   flip. It was written when `services/platform` had no `/api/v1/seo/*` handler at all; that handler has since
   landed (see "SEO discovery surface"), so the remaining condition is the page route's own 404 rule, not a
   missing controller.

Known gaps, stated as gaps: `/api/v1/guides*` and `/api/v1/collections/{slug}` still 404 with
`"No such endpoint"` (no growth read controller exists yet, so those web pages degrade by design), and
`GET /api/v1/offerings/{id}` has never been exercised. The `SeoController` claim in the paragraph above this one
was stale and is corrected here — `/api/v1/seo/routes` answers 200 and `/api/v1/seo/page` answers 404
for a stated reason, both measured in the "SEO discovery surface" section above (D24 records the §4 reads).
Screenshot inspection remains unavailable
in this environment (`NATIVE_BROWSER_VIEWPORT_UNAVAILABLE: In-app Browser did not provide a visible surface with a
positive viewport`), so every web claim above is an HTTP status plus a parsed-HTML assertion, not a visual check.

## Consumer catalog reads — API_CONTRACT §4 (2026-09-22, verified against the seeded database)

`com.nexus.catalog` now answers all six merchant reads the contract lists; the slice's "open a real merchant page"
step is no longer blocked on the platform. `mvn -o test`: **61 tests, 0 failures** (14 of them
`CatalogReadTest`). Then restarted the local platform on `:8090` and re-read every route over the seed:

```
GET /api/v1/merchants?district=Sha%20Tin&limit=2   200  total_estimate=179, sort=popularity, as_of stamped,
                                                      cards carry price/rating/open/facts, Cache-Control public +
                                                      s-maxage=300, Vary: X-Tenant, X-Demo-Data: true
GET /api/v1/merchants/basil-still-0014             200  朗澗小廚 · Hot Pot · Sha Tin, 36 keys, 2 locations,
                                                      20 hour rows, 6 top offerings, menu_count=20,
                                                      rating 3.62 (column) vs average_rating 3.63 (recomputed),
                                                      review_summary null, `plan` absent
GET …/menu?sort=-price                             200  20 active offerings, Angus Short Rib Slices HK$276.00 first
GET …/reviews                                      200  8 published rows + recomputed aggregate and distribution
GET …/reviews/summary                              404  review_summary_not_found — review_summaries is empty
GET …/availability?party_size=2                    200  Cache-Control: no-store, slots joined to their pool
                                                      (Table A — demo pool), capacity_left respected
GET /api/v1/merchants?sort=bogus                   422  validation_error
GET /api/v1/merchants/nobody-here                  404  merchant_not_found
```

Three behaviours worth stating because they are the ones a reviewer would call a bug:

- `?category=Hot%20Pot` and `?category=hotpot` both return 25 merchants, and the first card prints
  `category: "Indian"`. That merchant's own `merchant_categories` link points at the `hotpot` leaf, so it belongs
  in the aisle; the card still labels itself honestly. A slug nobody seeded (`hot-pot`, with the hyphen) returns 0
  rather than being fuzzy-matched into a result.
- `rating_agg` and `popularity_score` are `NOT NULL DEFAULT 0`, so "best rated" is `sort=-rating` (descending) and a
  bare token is ascending — the platform-wide `Paging.orderBy` convention, now asserted rather than assumed. Every
  explicit sort carries `nulls last`, and no whitelist fragment reads `plan`, campaign, coupon or spend (§66); the
  profile does not echo `plan` at all.
- Availability slots from the seed have `price: null` and `offering: null` — the slot rows genuinely carry neither,
  so the fields stay null instead of borrowing the pool's price (§19).

### Web: the §4 payload reaches `MerchantDetail` through a projection (2026-09-22, task #16, verified over HTTP on the prod build)

`data.ts:merchantBySlug` used to cast the profile into its own view-model. The §4 detail is a §2 card plus extras
(`title`/`price` not `name`/`avg_price`; `praise`/`complaints` not `themes`; canonical slot rows not `slot_id`/`status`),
so live mode rendered blank fields next to a full mock page. `apps/web/src/lib/platform-catalog.ts` is now the only
place that crosses those conventions — weekday remap (`0=Mon` wire → `0=Sun` UI), primary-location hours scoping,
currency-required money, `from_price → 'from'`, bullets-without-narrative summaries, capacity-derived slots — and it
casts nothing: every field is narrowed through a helper that returns `null` when the wire does not say it.
`npx tsc --noEmit` clean, `npx eslint src --max-warnings=0` clean, **70/70 vitest** (20 new cases on a verbatim
capture of the live profile), `mvn -o test` **62/62**, `pytest` **71 passed / 4 skipped**, `@nexus/sdk` **42 passed**.

Verified against `:3002` (`next start`, `NEXT_PUBLIC_DATA_MODE=live`) over HTTP with a 20-assertion script —
20/20: name, price, category, address, MTR, menu titles, review quote, hours text, `示範數據` provenance chip,
fact ids present, `open.source_fact_id` equal to the `opening_hours` fact the platform just emitted, no degraded
banner despite `/reviews/summary` answering 404, and the rating deliberately *absent* (no rating fact exists, so
the card shows 未验证 rather than the bare column). This is HTTP + parsed-HTML evidence only: the in-app browser
cannot produce a viewport here, so nothing about layout or colour was checked.

Three defects the verification itself turned up, all now fixed:

1. **`reasonOf(cause) === 'not_found'` was dead code in live mode.** `base.ts` synthesises that literal only for a
   non-JSON body; the platform's §1 envelope names each 404 after its subject (`merchant_not_found`,
   `review_summary_not_found`), so six call sites never matched. Consequences: every absent AI summary marked the
   merchant page degraded, and an unknown merchant slug 500d instead of rendering not-found. "Absent" is now read
   from the status (`data.ts:isNotFound`); `/m/nobody-here` → 404, `/m/basil-still-0014` → 200 not degraded.
2. **`@nexus/types` did not build**: `SCHEMA_ENUM_BINDINGS` had an unquoted `unknowns[]` key (TS1109), so the package
   was shipping a stale `dist/`. Quoted; build green. `packages/types/src/schemas/fact.json` also still listed five
   `FactSource` values after the TS union grew `demo` — the schema and the union are required to be equal, so both
   now carry `demo`, as do `packages/sdk`, both trust test fixtures and AGENT_CONTRACT §4.
3. **`env.ts` defaulted to `:8080`/`:8000`**, which on this machine belong to another project (D9): a live-mode start
   that forgot the env vars would have talked to a foreign service. Defaults are now `:8090`/`:8010`.

Still open on this page, in order of what they cost: no `rating` fact row exists for any seeded merchant, so the
rating stays 未验证 until that data decision is made (D25); `MerchantService.addHours` mirrored the wrong shape into
its fact (fixed here — it now writes the whole week, D25 §2), and until today it had **no HTTP route to be reached
through** — `com.nexus.merchant` has now gained `MerchantContentController` (businesses, verification, publish,
offerings, imports, dashboard, export), so the mirror is reachable, but the whole §23 write surface still has no
integration test of any kind;
`offerings.attributes` amenity booleans (`opens_late`, `wheelchair_access`, …) reach no chip because
`facts.attributes` has no dictionary copy for them, so an unknown key would render its own snake_case name;
`/api/v1/offerings/{slug}` has no platform handler, so `/o/[slug]` in live mode 404s; and `liveSearchRail` sends
`filters:{sort}`, which strict `SearchRequestFilters` rejects. One scope mismatch is recorded rather than fixed:
`OPEN_NOW` is true if *any* location of the merchant is open, while the profile prints the primary location's week
(a union of two schedules would be a third, fictional one), so on a two-location merchant the badge can be open while
the printed week shows closed at that hour.


## Parallel wave in flight (2026-09-22) — ownership map so streams do not collide

| Stream | Owns | Task |
|---|---|---|
| platform repair | `services/platform/**` | `mvn -o test` green (last lead run 2026-09-22: 61 tests, 0 failures) |
| ai http layer | `apps/ai/**` | `POST /ai/v1/search` + `/search/stream` SSE per D13, `GET /ai/v1/conversations/{id}` |
| db consolidation | `infra/db/**`, `infra/postgres/**`, `scripts/db_*` | seed is loaded into `nexus` on `:5433` (directory reads over it are quoted in the §4 section above); `v_merchant_funnel.revenue` still to be fixed in a **new** `V<n>` `CREATE OR REPLACE VIEW`; `nexus-platform-testpg` still holds the port the compose-managed postgres wants |
| consoles | `apps/web/app/merchant/**`, `app/admin/**`, `src/components/console/**`, `src/lib/console-*`, appended `dict.console` | §23 merchant console + §27 human review queue |
| lead | `docs/**`, shared `apps/web` files, prod :3002 | verification, this ledger, §157 self-review |

## Reservations can be released — and the platform build is red on another stream's in-flight package (2026-09-22, task #17)

Task #17's premise went stale under the work: `com.nexus.merchant` no longer ships without a controller (a parallel
stream landed `MerchantContentController`, which reaches `addHours` and so makes the D25 whole-week fact mirror
reachable over HTTP). What was actually missing was §6's `PATCH /api/v1/reservations/{id}` — the way out of a booking,
and the reason the demo hold `NX-RES-A5DMBX` still holds two of five seats. Ruled and implemented in D26:

- `PATCH /api/v1/reservations/{id}` — `{status:"cancelled", reason?}`, holder-only, 404 for anyone else's booking,
  guarded state machine in `ReservationService.cancel`, seats back in the same transaction, `completed`/`no_show`
  refused with 409, `reason` written to `audit_logs.metadata` because `reservations` has no column for it.
- `GET /api/v1/reservations/{id}` — the SDK already advertised this method, so the choice was to serve it or delete a
  promised capability. Served: the holder, or a workspace holding `read_orders` on that merchant; 404 otherwise.
- The booking replay guard keyed on `(user, slot, party_size)` while V2's partial unique index is `(user, slot)`, so
  changing party size passed the guard, claimed seats and hit the index — a 500 with a rolled-back claim. Same size
  replays, different size is now 409 `reservation_exists` naming the code to cancel.
- `@nexus/sdk`: `ReservationPatch` narrows `status` to `"cancelled"` at compile time, `cancel(id, reason?)` added,
  and the fake API's reservation fixture now answers `pending`. Two fixture lies went with it: the SDK's own
  idempotency test asserted `status === "confirmed"` (a state no route produces), and
  `apps/ai/nexus_ai/adapters/platform.py`'s offline stub returned `confirmed` from `create_reservation` while
  `nexus_ai/trust/injection.py` treats "the table is confirmed" as a claim to filter out of untrusted text.

Verified: `javac` over the three changed `com.nexus.catalog` files and `ReservationApiTest` with the Maven-resolved
classpath — exit 0, no diagnostics; `npm test` in `packages/sdk` — **43 passed / 0 failed** (including the new
reservation read/release/422 test); `.venv/Scripts/python.exe -m pytest -q` in `apps/ai` — **71 passed, 4 skipped**.

**Not verified, and it would be false to say otherwise: the eight new reservation assertions have never run.**
`mvn -o test` cannot compile the source set. Four errors, all in files this stream does not own:
`com/nexus/commerce/CartService.java:585` and `OrderService.java:159` reference a `PaymentService` that does not
exist yet (the package is untracked and still being written — only `PaymentRepository` is on disk),
`OrderService.java:89` calls a two-argument `ApiException.conflict` overload that does not exist, and
`merchant/MerchantContentController.java:304` calls `audit.record(request, …)` with seven arguments where the
request overload takes eight. The first three belong to the commerce stream's in-flight work and are deliberately not
touched: inventing `PaymentService` would collide with whoever is writing it. The fourth is a one-argument omission in
the merchant console, which is this task's own surface, and is left unfixed only because the build stays red without
the other three. Consequence for the live loop: the server on `:8090` is still the last green build, so it has no
cancel route — `scripts/verify_reservation.py` would pass its 12 existing checks and cannot yet exercise the release.

Next, in order, once `com.nexus.commerce` compiles: `mvn -o test` (62 + the 8 new); the one-argument
`MerchantContentController:304` fix; restart `:8090` from the green build; add the cancel leg to
`scripts/verify_reservation.py` and re-run `scripts/verify_consumer_slice.py`; then the gap that made this task
outlive its own title — `com.nexus.merchant` has a full write surface and still zero integration tests, so the D25
hours mirror is reachable and unproven at the same time.

## The contract layer can now check itself (2026-09-22, `packages/types`)

`@nexus/types` is the file every other stream copies shapes from, and until now nothing executed the claim:
`package.json` pointed at `scripts/validate_conformance.mjs` and `src/tests/*.test.ts`, and none of them existed. Both
are real now, and the gate they form is what paid for this increment.

`npm test` in `packages/types` runs **build → gen:schemas → conformance → test:unit**, all offline, on
`typescript` + `tsx` + `@types/node` only (the validator is hand-written for the same reason `ajv` is not a
dependency). Result: 7 schemas, 28 schema↔enum bindings, 48 fixture cases (29 negative), 21 cross-object rules,
**429 checks**, plus **30 unit tests** in `src/tests/{enums,schemas,types}.test.ts` — which are themselves typechecked
(`tsconfig.test.json`) because `tsconfig.json` excludes them to keep `.mjs` imports out of `dist/`.

What the gate found, all of it fixed:

- **`entity_card.tenant_id` was unsatisfiable.** `oneOf` over *uuid or slug*: a lowercase uuid matches the slug pattern
  too, so every valid tenant id matched two branches and the field could only ever be `null`. Now `anyOf`, with the
  reason in the schema description so nobody "tightens" it back.
- **A fixture invented an agent.** `fixtures/tool_spec.json` listed `merchant_onboarding` among the agents allowed to
  call `search_web`; no such name exists in `AGENT_NAME`. A fixture that names a component the roster lacks is how a
  contract grows a fiction.
- **The trust order was misquoted.** A rule comment in `scripts/rules.mjs` quoted AGENT §4's conflict order in
  `FACT_SOURCE`'s *declaration* order (`imported` before `observed`) instead of its priority order, so the file that
  enforces the order documented it wrong. Now verbatim, and a test asserts the first five entries against the sentence.
- **A rule would have rejected valid specs.** `tool_spec_permission_matches_scope` also refused any merchant-scoped
  tool; `refund_payment` and `configure_ai` are legitimate merchant grants (§8/§27), so the heuristic is gone and the
  rule asserts only what §8 says — a tenant-scope tool needs a tenant-level permission.
- **`facts.attribute` could not express two of §5's TTLs.** `review_summary` and `popularity` have freshness windows
  (§20) and `apps/web` already seeds a `review_summary` fact, but neither name was in `FACT_ATTRIBUTE` — the two most
  cache-sensitive claims on a card had no attribute to be stored under. Registry extended, recorded as CONTRACT NOTE 10
  (the column is free text, so no migration is blocked), and pinned by a test that fails if a TTL key has no vocabulary.
- **~90 comments cited `V1 line NNNN`, and two were wrong.** `messages.content_type` pointed one line early and
  `notifications.channel` one line late. The new test parses the V1 DDL, takes the table/column named on the citing
  line, and requires the cited line to contain it — which is the only way a mirror of someone else's artefact stays
  honest as that artefact moves. `src/index.ts` also claimed `DECISIONS.md` and disk disagreed on the migration path;
  both say `infra/db/migrations/`, and the claim is now a test rather than a comment.

**Boundary, stated plainly:** this gate checks schemas, enums and fixtures. It does not observe a running service, so
it cannot say the platform or the AI service emits conformant payloads — only that anything which does not will fail
against the same published rules. The Java tree is unchanged and still red on `com.nexus.commerce` (see above), so
task #17's eight assertions remain unrun.

## Live payloads against the published contract (first run 2026-09-23, `scripts/verify_payload_conformance.mjs`)

The boundary above was answered the same day it was written. The script reads the *published* artefacts
(`packages/types/dist/schemas/` via `manifest.json`, so a stale `gen:schemas` cannot flatter a run), issues six
documented reads against :8090 and :8010, and validates every returned object with **the same validator and the same
21 cross-object rules the fixtures are held to** — rules are wired in as of this run, which is what surfaced the last
two rows of each class below. 38 payloads: **59 violations, 20 platform / 39 AI, zero of them in an error envelope
after D27.** An unreachable service is reported `NOT VERIFIED`, never as a pass.

Every row is classified by who must move, and the classification was made by reading the payload, not the message:

| # | Violation | Count | Owner | Verdict |
|---|---|---|---|---|
| P1 | Directory cards render `rating` (e.g. `{value:5,count:4}`) with **no `rating` fact** on the card — `facts[]` carries only `price` + `opening_hours` | 5 | platform `com.nexus.catalog` + seed (tasks #4/#15/#8) | **§19 breach, service side.** The number is real (`rating_agg`/`review_count`) and unbaked into the provenance layer. Either the projection writes the `rating` fact it is reading, or the card sends `rating: null`. |
| P2 | `avg_price_hkd: 81.43` on a closed `EntityCard`, duplicating `price.amount: "81.43"` as a bare float | 5 | platform `com.nexus.catalog` | **Service side.** §1 says money is a decimal *string* + currency; the card already carries it correctly in `price`. Drop the duplicate. |
| P3 | `city: "Hong Kong"` on a closed card — `GeoPoint` has `lat/lng`, the card has `district`, and no §4 query takes a city | 5 | platform `com.nexus.catalog` | **Service side.** HK is the tenant, not a field. A second city is a contract edit request, not an extra key. |
| P4 | `category: "Tea House"` where the field's own pattern demands a snake_case code | 5 | platform `com.nexus.catalog` | **Service side.** The card carries the *slug*; the display name comes from the taxonomy dictionary, which is what makes one card render in three locales (§2's single render contract for consumer + AI + MCP). |
| A1 | `organic_rank` and `score_breakdown` (eight scoring components) on consumer cards | 10 | AI `nexus_ai/search/cards.py` | **§66/§116 leak, service side, the most serious row here.** Ranking internals — including the paid/organic separation inputs — in the render contract that also feeds MCP and UCP. If it belongs anywhere it is a debug rung behind an explicit flag. |
| A2 | `availability: {status: null, next_slot: null, source_fact_id: null}` — `AvailabilityStatus` is not nullable and the field is `fact_id`, not `source_fact_id` | 5 | AI `search/cards.py` | **Service side.** "No availability signal" must be the documented `unknown`, and the rule behind it agrees: the card *also* renders availability with no backing fact and no `as_of` (A5). |
| A3 | `rating: {value, count, fact_id}` — `RatingInfo` is closed at `{value, count, smoothed?}` | 5 | AI `search/cards.py` | **Service side, ruled in D28.** The citation belongs to `facts[]`; a per-field id on one object and a differently-named one on another is how the two drift. |
| A4 | `actions[].type` `"view"` / `"ask"`, outside `CARD_ACTION_TYPE` | 7 | AI `search/cards.py` | **Service side.** `view_menu`/`view_reviews`/`compare`/`message` are the documented verbs. A CTA whose verb the renderer does not know renders as an unlabelled button. |
| A5 | `actions[].endpoint` `/ai/v1/compare` — a mutation-shaped path on the AI origin | 7 | AI `search/cards.py` | **Service side, against D5**, and the schema field's own description says so. `compare` takes `endpoint: null` (client-side action) exactly as §2's CardAction documents. |
| A6 | Cards render `availability` and an `open` verdict with no backing fact, no `as_of`, and `source_fact_id: null` while an `open_state` fact **is on the same card** | 5 | AI `search/cards.py` | **Service side.** AGENT §4's renderer contract. This is the same root as the `stable_fact_id` refactor already sitting uncommitted in that stream's working tree — the fix is in flight, not missing. |

Also from the same run, unchanged and still open: `POST /ai/v1/search` with an empty query returns **0 items**, and
`SearchRequestFilters` has no `sort`, so all four live home rails (`apps/web/src/lib/data.ts` asks for
`{sort: 'distance' | 'rating' | 'trending' | 'price_low'}`) answer 422 and fall back to empty. There is **no
documented live source for a query-less "near you" rail**; the honest options are a §4 directory sort by distance or a
contracted query-less search, and the rails must not be quietly left on mock data — §166's vertical slice is a live
slice. `GET /api/v1/merchants/{slug}` (the merchant profile, 36 top-level keys) has **no published schema**, so the
run records it as `NO SCHEMA` rather than pretending the count is a pass.

**What D27 did and did not settle.** §1's example code is now legal, the three error-envelope probes validate, and
`error_http_status_matches_code` gained real power it never had — a `slot_not_found` served with 403 fails the
contract instead of being skipped as an unknown name (pinned by fixture `09_invalid_resource_code_status_disagrees_with_suffix`,
and by `ladderErrorCode`'s sixteen-case table, which answers `null` rather than a guess for `validation_failed`,
`merchant__not_found` and `Merchant_not_found`). Nothing else in the table above became legal because a service
happened to send it: 59 rows, one ruling, and the other 58 stay filed with owners.

## The drift checker was under-matching, and the two gaps it hid (2026-09-23, `scripts/check_contract_drift.mjs`)

The §5 row added for `GET /api/v1/merchant/reservations` triggered the first real audit of the checker itself: the
route is documented and called by `web`/`web-lib`/`sdk`, and no controller serves it — yet the run said *served*.
The forward match searched a source corpus for the **last one word** of a documented path, so `reservations` matched
`PATCH /api/v1/reservations/{id}` and the gap vanished. A gate that cannot tell two routes apart is not a gate
(§156: build, then look at what the build actually asserted).

Three changes, each covering a distinct way to be wrong:

1. **`serverSignature` + `declares`** — a service-side hit is now the *last two* segments as a anchored regex
   (`/{id}/reindex` cannot be satisfied by `/reindex` alone), and because Spring splits a route across
   `@RequestMapping` base path and `@GetMapping`, a hit may also be any *pair* of literals in the same file.
   Without the pair rule the tightening falsely demoted 16 routes (`/api/v1/me/favorites`, `/api/v1/seo/page`, …).
2. **Wildcard shorthand is excluded from both directions.** `/api/v1/me/*`, `/ai/v1/**` and friends are prose for a
   family the same section lists one row at a time; matching them asks a file to contain a literal asterisk, and
   whatever it hits is an accident. They are printed as `wildcard shorthand, not treated as endpoints` and never
   counted either way.
3. **Reverse direction kept** — a path literal in code that the contract never defines is still drift, with class-level
   base paths accepted as strict prefixes and *extensions* (`/x/{id}/reindex`) still reported.

Current ledger: **101 routes parsed · 64 served · 29 client-only · 0 missing · 0 undocumented**, over a 270-file
corpus (platform 114, ai 58, web 25, web-lib 47, sdk 26). `.github/workflows/ci.yml:202` runs it with `--report`, so
CI stays advisory while the 29 rows are worked off; the split is by owner, not by excuse.

Two of those 30 were true gaps that the old matcher hid, and both became visible rather than passed (that count is
from the run that found them; the ledger has since moved to 29 and is re-measured above rather than back-filled
here, because the route that left the list did so in another section's wave):

| Route | Evidence | Verdict |
|---|---|---|
| `GET /api/v1/admin/system/health` | `SystemController` serves `/api/v1/health` and `/api/v1/ready` only | **Contract or BFF mount, not a missing handler.** The admin surface has no health of its own; either the SDK's admin client targets `/api/v1/health`, or the §9 admin route must be written. Do not satisfy the checker by renaming a route nobody authorised. |
| `GET /api/v1/merchant/reservations` | `com/nexus/commerce/` contains **no controllers at all** (`CartRepository/CartService/OrderRepository/OrderService/PaymentRepository`) | **Was §23's unbuilt booking inbox; built the same day** — see the next section. Left in the table because the finding, not the route, is the point: the AI tool `read_orders` and the merchant console had both been calling a path nobody served, and only the corrected matcher said so. |


## The inbox, and a filter that made valid requests illegal (2026-09-23, task #17)

Closing the second row above meant writing the §23 booking inbox, and writing it found a defect that had nothing to
do with reservations. Four things landed:

**`GET /api/v1/merchant/reservations` is served** (`MerchantContentController#reservationInbox`, backed by
`ReservationRepository#inbox/#inboxCount` and `ReservationService#inbox`). What the tests pin is not the JSON shape
but the honesty of the numbers: an inbox with no bookings is empty rather than seeded (§109); rows come back ordered
by `starts_at`, so a merchant reading at 18:00 sees tonight before tomorrow; the date window is half-open
(`>= from`, `< to`) because an inclusive `to` double-counts a booking that spans midnight; `status` is validated
against the five stored values instead of silently matching nothing; and a denied read leaves exactly one
`permission_denied` audit row, which is the only proof that the 403 came from the interceptor and not from a filter
that gave up earlier. `contact` is projected in full — the merchant has to call the guest back — while `user_id` is
not, because it identifies a person to the platform, not to the café (§46/§47). No route accepts a booking, so
`inboxOrdersByArrivalAndFiltersStatus` sets `confirmed` by direct SQL and says so in a comment; pretending otherwise
would document a capability D26 withheld.

**`PaymentService` existed only as a name.** `CartService` and `OrderService` both referenced it and the package did
not compile (`mvn -o compile` failed four times before anything could be tested). The class is a projection, not a
payment flow: `client_secret_ref`, `idempotency_key` and `provider_ref` are columns that exist and are deliberately
never selected, because for a provider we do not integrate with, field selection *is* the control (§42). Every
intent carries `card_data_stored: false` and a notice saying no money has moved.

**The filter that decided by framing.** `CachedBodyFilter` buffers the JSON body so the permission interceptor can
read `merchant_id` out of it before the controller consumes the stream. It only did so when a `Content-Length` was
present — and the Jackson converter streams, so a `RestTemplate`/`fetch` POST with a `Map` body sends chunked. The
result: a perfectly valid `POST /api/v1/merchant/offerings` was answered 422 `validation_error`, while the identical
bytes sent with a length returned 201. `WorkspaceAccess` had drained the stream and the controller then saw EOF. The
diagnosis came from a scratch probe test, not from reading the filter again, which had already looked correct twice.
The cap now applies to the bytes actually read rather than to the advertised length, chunked JSON is cached, a
declared `0` is treated as the empty body it is, and an over-cap body is refused with a 422 that names the 256 KiB
limit instead of pretending the payload was malformed. **Authorization must not depend on how the client framed the
request** — that is the same bug class as a tenant guard that trusts a header the SDK chose to send. Both regressions
are permanent tests (`bodyFramingDoesNotDecideWhetherTheRequestWorks`, `oversizedBodyStatesTheLimit`).

**One test was asserting the wrong thing.** `ReservationApiTest.foreignBookingCannotBeReleased` expected 404 for a
cross-tenant cancel and started failing with 401 after the filter change. The fixture, not the code, was wrong: the
`patch()` helper hardcodes `X-Tenant` for the *home* tenant, so the "attacker" was really a request whose token and
tenant header disagreed — `AuthFilter:82` rejected it before any scoping logic ran, so the test had passed for three
weeks without ever touching tenant isolation. It now sends the other tenant's header *and* that tenant's own token,
and asserts the error code is `reservation_not_found` rather than only the status, so a future 404 from an unrelated
cause will not be read as a pass.

Also fixed in passing: `archiveOffering`'s audit `before` image was taken *after* the update, which could only ever
record `archived → archived`; it now reads first, and `archiveAuditsWhatItReplaced` asserts on the JSONB columns.

`mvn -o test`: **90 tests, 0 failures, 0 errors** (MerchantConsoleTest 10/10, ReservationApiTest 18/18). Drift
ledger moved from 63/30 to **64 served / 29 client-only**, corpus 267 → 269 files. Still open from this wave: the
`:8090` instance has not been restarted from the new build, so the inbox has not been curl-verified live yet, and
`/api/v1/admin/system/health` remains a contract-or-mount decision rather than a handler.

## The seeded demo database had zero usable permissions (2026-09-23, task #19)

The first live curl of the new inbox answered **403**, and it was not the inbox's fault. Signing in as the
seeded merchant owner and asking for its own booking list returned:

```
{"error":{"code":"forbidden","message":"You do not have permission 'read_orders' for this merchant",
 "details":{"permission":"read_orders","merchant_id":"8fcdeff4-…-12a456055e99"}}}
```

Counting the rows explained it: `permission_grants` has 15 `merchant_user` grants and **all 15 point at the
`merchant_users` row id**, while `PermissionService` resolves a grant by joining `users u on u.id =
g.subject_id` — the column has no foreign key, so the wrong id loads cleanly and is simply unreachable
forever. Meanwhile the three `owner` memberships carry no grants at all. So of the 520 seeded merchants, the
three that have a staff row at all are locked out of every permission-checked console route, and the other 517
nobody can sign into; §87's "sign in as a merchant" demo included. `data/seed/quality.sql` sweeps every
declared FK dynamically across its 54 checks, and this pair has none, which is exactly why the gate never saw
it.

Three fixes, in order of durability:

1. `data/seed/generate.py` now writes `user_id` into `subject_id` for owner grants.
2. Two new quality checks so the class cannot return: *merchant_user grants reach a membership* (joins the
   same way the service does) and *every seeded owner membership has grants* (the inverse case — a
   membership nobody can use). Measured against the loaded dev database they report `15 unreachable of 15`
   before the repair and `0 of 15` after.
3. The already-loaded `:5433` dev database was repaired in place with the equivalent `UPDATE` (15 rows), so
   the demo console works before the next full reload.

`GET /api/v1/merchant/reservations` then answered **200** live with one real row, whose projection matches
the tests: `contact` present (`{"name": "Verify Run", "phone": "2345 6789"}`), `user_id` absent, `status`
`pending`, and `price` `null` because the slot it was booked into has no price.

## The workspace claim survived login and died at the 15-minute mark

While writing the live walk for the inbox, the merchant session turned out to carry its workspace in a claim
named `mer`, not `merchant_id`. Fixing the walk exposed the real bug: `AuthService.rotate()` built its claims
map by hand and included only `role`, so **every refreshed token lost `mer`** — a console that opens its
default business from the token works for 15 minutes and then stops, which no test could have caught because
**nothing in the suite had ever called `/api/v1/auth/*`**. Related: only the demo login resolved the
workspace; `login` and `oauth` passed `null`, so a merchant who registers with a password gets a thinner
session than one who clicks a demo button.

`issueTokens` and `rotate` now share `workspaceClaims(role, merchantId)`, and the password/OAuth paths resolve
`defaultMerchantId` the way the demo path always did. `com.nexus.identity.AuthTokenTest` (3 tests) pins the
outcome: no `mer` before a membership exists, `mer` present after rotation, the rotated token accepted by a
real route, reuse of a spent refresh token answering `refresh_reuse_detected` **and killing the family**,
`HttpOnly` + `no-store` on the session cookies, and the register validation/409 shapes. §3 of the contract now
documents both claims (`role` is the account role; the workspace role stays on `merchant_users`) and the
re-resolution on rotation.

## Two default ports pointed at other projects, and the dev launch is now written down

`application.yml` defaulted `nexus.redis.url` to `:6379` and `nexus.ai.base-url` to `:8000`; on this machine
both are live listeners belonging to other stacks (the walk of `docker ps` shows `careeros-*` and friends),
and D9 pins NEXUS to 5433/6380 with the AI service on 8010. Left alone, a plain restart would have written
rate-limit keys into someone else's Redis and posted query text plus the internal token to a service that is
not ours. Defaults (and the two `@Value` fallbacks in `KeyValueStore`/`HttpImportAdapter`, which carried the
same wrong numbers) now point at the pinned ports; `application-dev.yml` no longer names `:5432` and no longer
ships a password default. Evidence from the restarted instance: the boot log prints
`key_value_backend backend=redis url=redis://127.0.0.1:6380/0` and `/api/v1/ready` reports
`{"database":"up","schema_version":"3","key_value_backend":"redis"}`.

`scripts/run_platform_dev.sh` exists because the launch command lived only in a previous session's scrollback:
it sources the (gitignored) `.env`, states every port out loud, refuses to trust the profile defaults, and
prints a warning rather than silently disabling the agent's conversation writes when
`NEXUS_AI_INTERNAL_TOKEN` is absent. **Still not aligned** — deliberately, because those files are dirty in
another stream's working set: `Makefile`'s `dev-web/dev-ai/dev-platform` targets still say `:3000/:8000/:8080`
and `.env` still carries `NEXT_PUBLIC_PLATFORM_URL=http://localhost:8080`,
`NEXT_PUBLIC_AI_URL=http://localhost:8000`, `PLATFORM_INTERNAL_URL=http://localhost:8080`. Whoever owns the
infra wave should retarget them to 3001/8010/8090.

Filed from the same walk, with numbers: **23,979 of 32,492 seeded `availability_slots` rows have no
`price_amount`** (and 1,172 are already at `capacity_left = 0`), so three bookings in four read `price: null`
end to end. Null is honest — the merchant never priced the slot — but it means the "this booking costs HKD X"
demo cannot be shown on most seeded slots, and any UI that renders `null` as `0.00` would be lying; the
distinction between *free* and *not stated* needs to survive into the card. Also filed: there is **no
"list my merchants" route**, so a console must read its workspace from the token claim; the walk decodes the
JWT it was handed to find out which business it is allowed to query, which is a reasonable client but a thin
contract.

## A migration that could not boot, and the seed it broke on the way in (2026-09-23, task #19)

`V4__tenant_scoped_identity.sql` was written, tested against `nexus_test`, and then refused to start the service:

```
Script V4__tenant_scoped_identity.sql failed
SQL State  : 42501
Message    : ERROR: must be owner of table user_identities
```

Not a bug in V4. `infra/docker-compose.yml` pinned `SPRING_FLYWAY_USER: nexus_app`, and `nexus_app` owns no table —
`00_roles.sql` gives it `USAGE, CREATE` on the schema, which lets it make new objects and nothing else. Every
migration before it had slipped past that: V1/V2 were applied out of band by the infra script, and V3 is a
`CREATE OR REPLACE VIEW`, which works only because that same script hands view ownership to the app role. V4 was
the first migration that had to change a table, so the assumption that the service migrates itself at boot died
with it. Ruled in **D30**: the credential that migrates is not the credential that serves. `application-dev.yml`
now carries `spring.flyway.url/user/password` from `NEXUS_MIGRATION_DB_*` (defaulting to `postgres` +
`NEXUS_DB_ROOT_PASSWORD`, which is in the gitignored `.env`), compose says the same thing explicitly, and the
runtime datasource stays `nexus_app`. `/api/v1/ready` then reported `schema_version: 4`.

The same file also revealed that `application-dev.yml` had **never been active on a host launch**. Nothing set
`SPRING_PROFILES_ACTIVE` except compose, so `scripts/run_platform_dev.sh` was running the base defaults while
everyone believed the dev block's port pins were in force. The launcher now names the profile and the migration
credential out loud.

Then the checksum incident, which is worth remembering: V4's header cited "D28", but D28 had been taken by the
card-citation ruling while V4 was in flight, so the reference was renumbered to D29 — after the migration had
already been applied. The next boot refused with `Migration checksum mismatch for migration version 4`, because
Flyway hashes the file's text, comments included. The way out was to delete the V4 row from
`flyway_schema_history` and let the migration re-run, which was safe *only* because V4 was written resumable
(`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`, backfill guarded on `IS NULL`). Measured after the
re-apply: `user_identities_tenant_uniq` and `users_email_tenant_uniq` present, 5 identity rows, 0 with a null
tenant, 5 live users, 4 reservations still in place. **Lesson: an applied migration's text is frozen; the header
comment is part of its identity.**

Two follow-on fixes the boot did not catch:

* `scripts/db_apply_migrations.sh` and Flyway keep separate ledgers (`schema_migrations` holds
  `V1__init, V2__integrity, V3__merchant_funnel_no_fanout`; Flyway held `2(baseline) → 3 → 4`). The infra script
  would have re-run V4 over a database Flyway had already migrated. It now reads Flyway's history too:
  `= skip  V4__tenant_scoped_identity (applied by the service's Flyway)`, and records it in its own bookkeeping.
* **V4 broke the seeder**, and only a fresh database could show it: `data/seed/out/03_user_identities_*.sql`
  copies the columns the file lists, `tenant_id` was not one of them, and the load died with
  `null value in column "tenant_id" of relation "user_identities" violates not-null constraint`. The dev database
  could never have surfaced that — its identity rows predate V4 and were backfilled. `generate.py` now emits the
  column and adds it to the self-check's FK map.

To prove the pair, the seed was rebuilt from scratch in a throwaway database (`nexus_qc_lead19` on
`nexus-platform-testpg`: create → `db_apply_migrations.sh` → `RESEED_DEPENDENTS=1 load.sh` → `quality.sql`), which
is the first time the seeded dataset has been validated against a V4 schema. Result: **153 checks, all pass**,
including `orphan: permission_grants.merchant_user — 0 unresolvable subject_id of 15 grant(s)` and
`no seeded orders/reservations`. That orphan check is where **D31** came from: it had been passing while the demo
console 403'd on every workspace route, because it resolved a `merchant_user` grant against `merchant_users.id`
while `AuthorizationInterceptor` looks the subject up by the *person's* id (`principal.subjectId()` /
`userId()`, both ids on `users`). The probe now joins the way the interceptor does — person plus active membership
at the same merchant — so it can no longer certify a shape the service cannot read.

Live walk against the restarted service (`PYTHONIOENCODING=utf-8 python scripts/verify_reservation.py`):
**29/29**, first green run that covers the consumer hold, the §23 merchant inbox and the cancel leg in one pass.
One assertion was wrong rather than the server: the inbox leg books the same slot the first leg already holds
(the demo merchant *is* the first merchant in the directory), and one-live-hold-per-person-per-slot (V2) returns
that earlier row with 200 and a `status_note` saying so — so the contact the merchant sees legitimately belongs to
the first booking. The check now compares the inbox row against the booking response instead of a literal this
script typed, and the leg prefers a slot it has not already claimed. `mvn -o test`: **94 tests, 0 failures** on
`nexus_test`.

Still open from this wave: the scratch gate database was dropped after the run and has no automated trigger yet —
`make` still does not build a fresh DB and gate it; and the drift ledger reads
101 routes parsed · 64 served · 29 client-only · 0 missing · 0 undocumented over a 270-file corpus (platform 114,
up one from another stream's file). Two items it listed are now closed in the section after this one: `nexus_app`'s
leftover `CREATE`, and `nexus_test` having no migration ledger at all.

## A privilege nobody needed, and a database whose schema had no record (2026-09-23, task #20)

Committing the previous wave (`599cfce`) left one of its own open items mis-stated: D30 justified not revoking
`nexus_app`'s `CREATE ON SCHEMA public` because "`00_roles.sql` only runs on a first-boot volume". The file's own
header says otherwise — `scripts/db_apply_migrations.sh` re-applies it after the migrations precisely so the grants
bind to real tables. So the narrowing is a two-line edit in the file that made the grant, and it reaches the
existing dev database on the next run rather forking it from fresh volumes (**D32**).

What the privilege had been buying was nothing, and the proof is the failure that removed it: schema `CREATE`
permits new objects, not changes to objects someone else owns, which is exactly why V4 died as
`42501 must be owner of table user_identities` *while* `nexus_app` held `CREATE`. After the revoke, measured:

```
nexus       nexus_app acl = pg_database_owner=UC/…, =U/…, nexus_app=U/pg_database_owner, nexus_ai=U/…
nexus_test  nexus_app acl = pg_database_owner=UC/…, =U/…, nexus_app=U/pg_database_owner, nexus_ai=U/…
$ psql -U nexus_app -d nexus_test -c 'create table public.lead_probe_20(id int)'
ERROR:  permission denied for schema public
```

and the same role still serves everything that matters: `mvn -o test` **94/94** against `nexus_test`, and
`scripts/verify_reservation.py` **29/29** against the running :8090 — which needed no restart, because Postgres
checks privileges per statement, not per connection, so the revoke applied to the already-open pool the moment it
landed. What keeps future migrations working without it is `ALTER DEFAULT PRIVILEGES`, already in the same file: a
table V5 creates arrives with DML for `nexus_app` and nothing at all for `nexus_ai`.

Applying that to `nexus_test` is where the second problem surfaced, and it is the one D30 point 2 only suspected.
The test database has the complete V1–V4 content — its index and constraint sets match `nexus` one for one, 334
rows, with the only three differences being Flyway's own bookkeeping objects — and records **zero** rows in
`schema_migrations` plus no `flyway_schema_history` at all, since `NexusIntegrationTest` sets
`spring.flyway.enabled=false`. Against it, `db_apply_migrations.sh` re-ran V1 and aborted on
`relation "tenants" already exists`, which — being `set -e` — also skipped the role grants below. So a disagreeing
ledger did not merely misreport the database, it made the database un-maintainable by the only script that can
reach it.

The fix is not detection, it is declaration (**D32**). `apply_file` now separates the two failure classes: an
`already exists` error stops with a message that names the condition (content predates ledger, hand-built schema,
or half-applied) and prints the repair, while any other SQL error propagates unchanged inside
`--single-transaction`. `--record V<n>__<name>` then writes the ledger row and executes nothing, printing that it
did. Auto-detection was rejected on purpose — a subset check passes on a half-built schema, a full check would have
to understand every migration file, and a wrong row makes a later real migration skippable. The four rows for
`nexus_test` came from the 334-row comparison above, and the transcript is
`= recorded V4__tenant_scoped_identity as applied WITHOUT executing it / ledger only — nothing ran against
'nexus_test'`. Afterwards a plain run is quiet: four `= skip`, then the grants, then
`tables=57 · migrations=4`.

The wave also corrected two doc claims that D30 had orphaned: `DEPLOYMENT.md` §5 still described `nexus_app` as
"also the Flyway role in dev", and `db_apply_migrations.sh`'s view-ownership comment still asserted that the next
`V<n>` runs as the app role — true before D30, load-bearing for nothing after it, so the comment now says the
transfer is belt-and-braces and names the configuration it protects.

Still open: `nexus_test`'s ledger is now *recorded*, not *validated* — nothing runs the migration files through it,
so a hand-built schema that drifts from `V*.sql` would still be invisible until something errors; the
client-only routes remain unowned. Two items this paragraph listed are closed in the section after it: the missing fresh-DB gate trigger, and `API_CONTRACT.md` §0 calling
`nexus_app` the owner of the commerce tables.

## Building the database nobody had ever built (2026-09-23, task #21)

D30's seeder break and D32's ledger-less database had the same shape: a defect that only exists on a path nobody
ran. So the path got a command. `scripts/db_gate_fresh.sh` creates an empty database from `template0`, applies
`V*.sql` + `00_roles.sql` into it, regenerates the dataset, loads it, runs `data/seed/quality.sql` as a hard gate
and drops the database (**D33**). It refuses to start unless the target is empty, refuses the four names that hold
real data, and resolves the container by asking which one answers rather than trusting a compose file — this
workstation has five Postgres containers and two of them are other projects'.

First run failed, which is the point of a gate. `load.sh` aborted with
`ERROR: .../data/seed/out looks incomplete (no 21_collections.sql)` against a directory `generate.py` had just
produced correctly. The writer emitted `f"{prefix}_{table}.sql"` where `prefix` is already `21_collections`, so
every SQL file repeated its table name while the docs, the CSV sibling and the loader's probe all said
`21_collections.sql`. `git log -S` puts the line in `e237f6d` — the parallel build wave, not the seed work — and
it survives review because `out/` is gitignored: the only machine that ever sees the failure is a fresh clone, and
the probe there checks *existence*, not freshness. The fix is the documented name plus a wipe of the previous run's
`out/*.sql` and `out/*.csv`, since `load.sh` globs the directory and a rename that leaves both spellings behind
makes it COPY every table twice — a duplicate-key error naming a random table, with the stale file nowhere in the
message. Third run:

```
=== 5/5  data/seed/quality.sql (the hard gate)
RESULT: PASS — 153 quality checks passed against a from-scratch schema (tables=57, migrations=4)
        SYNTHETIC DEMO DATA. The live databases were not opened by this run.
```

The gate also paid for itself on documentation. `DEPLOYMENT.md` §6 told the next agent to run
`docker exec nexus-postgres psql -AtU postgres -d nexus`, and that command fails here with
`FATAL: role "postgres" does not exist` — `nexus-postgres` is a *different* stack's container (it publishes
`:55433`), while `nexus-platform-testpg` holds `nexus`, `nexus_test` and `nexus_funnel_probe` on the documented
`127.0.0.1:5433`. `container_name: nexus-platform-postgres` in the compose file is not running at all. The
checklist now names the containers that answer, and the "57 tables" it promised is explained rather than asserted:
`V*.sql` + `00_roles.sql` create 56, the infra ledger adds `schema_migrations` (57, what the gate reports), and a
service boot adds Flyway's own `flyway_schema_history` (58, what `nexus` shows). §8's "decide the schema owner"
pre-deploy item is closed — D30/D32 decided it — and replaced by the part that is genuinely still open: making the
same split work on a hosted instance where the table owner is not the connecting user, which is the case
`ALTER DEFAULT PRIVILEGES` silently does nothing under.

Two things this wave nearly got wrong, and both are worth writing down because the measurement was misleading rather
than absent. `git add` of the new script printed `warning: in the working copy of 'scripts/db_gate_fresh.sh', LF
will be replaced by CRLF the next time Git touches it`, and with `core.autocrlf=true` set globally on this machine
that is the statement that a checkout can hand every one of the repo's four shell scripts to `bash` with a `\r` on
each line — the repo had no `.gitattributes` to overrule it. It now pins `*.sh text eol=lf`, which is a no-op on
the current files (all four are LF in the working tree and in the index) and a guarantee on a future checkout.
Confirming that took byte-level inspection, because the obvious probes here lie: `$(grep -c $'\r' file)` reports
*the file's line count* — the CR disappears inside command substitution, leaving an empty pattern that matches every
line — and `git checkout-index` does not apply the smudge filter, so checking a file out into a temp directory
proves nothing about what a clone would write. `python -c "open(p,'rb').read().count(b'\r')"` is the only one of the
three that answers the question; it is what established that the script was and is LF, and that the staged blob is
too. (This belongs in the same ledger as the GBK psql output and `| tail` swallowing exit codes.)

Still open: the gate has no `make` target (`Makefile` carries another stream's uncommitted edits, so the target
belongs to whoever next owns that file); nothing invokes it, so a migration that only works on a database which
already has content can still merge — at 63 seconds per run it is cheap enough to be a pre-merge check, and it
is not yet one; and `nexus_test`'s recorded ledger is validated by nothing — a from-scratch build proves
the migration files, not that the hand-built test schema matches them. A third gap surfaced while reading §8 for
the collections read path: `API_CONTRACT.md` §8 describes `collections.items` as an ordered array of typed blocks
(`{type: paragraph|heading|list|cards}`, a `cards` block carrying entity ids), while V1's own column comment and
every seeded row use a flat `[{subject_type,subject_id,note}]`. Neither document is wrong about its own layer, and
the mismatch will bite the first page that renders a guide — it needs a ruling, not a silent pick.

## Four endpoints nobody had served, and the column shape they disagreed about (2026-09-23, task #22)

The §8 collections/guides read path was delegated; the agent landed `CollectionsRepository` and stopped at the
words "Now the controller." That is a half-finished slice, not a result, so the controller, the tests and the
ruling below are the lead's. The repository turned out to be worth keeping: its `WHERE` carries the publishability
predicate (§8's "absent provenance is `creator` only when `author_id` is a real user, otherwise the row is not
publishable") as SQL rather than as controller logic, which is what makes the list and the by-slug 404 unable to
disagree about what is readable.

Reading §8 to write the handler found a contract/storage divergence (**D34**): §8 described
`collections.items` as an array of typed blocks (`{type: paragraph|heading|list|cards}`) while V1's column
comment, DATABASE.md §3.9 and all four seeded rows describe the flat `[{subject_type,subject_id,note}]`. A
block-only reader renders **zero cards for every guide in the demo**, so the ruling had to be made rather than
worked around: the flat array is the storage contract, resolution is a read-side concern, and a typed element is
passed through unresolved instead of deleted. No migration adds block storage — nothing writes it and no consumer
reads it.

`/api/v1/collections`, `/api/v1/collections/{slug}`, `/api/v1/guides` and `/api/v1/guides/{slug}` are now served:
public, `Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=86400`, `Vary: X-Tenant`,
`X-Demo-Data` badged off `data_origin`. Merchant references resolve through `MerchantCards` — one batched read per
row, never one per item — so a guide's card is byte-identical to the same merchant's card in the directory, keys
and all, with the open state stamped by the instant of that read. Unresolvable ids drop and are named in
`dropped_item_ids`; `item_count` still reports what was stored. `POST /api/v1/collections` remains unbuilt
deliberately: it creates a publishable consumer page, so it belongs behind the permission chain with the §27
authorization on the row, not beside four anonymous reads.

Verification, on a throwaway instance on `:8091` so the already-running `:8090` was not disturbed:

```
mvn -o test                       104/104  (CollectionsReadTest 10, from a standing 94)
GET /api/v1/guides                1 guide · creator · curated_by 陳小姐 (Demo) · item_count 10
GET /api/v1/guides/sha-tin-date-night
                                  item_count 10 · items 10 · cards 10 · distinct shops 9 · dropped 0
                                  noindex true · "not reviewed by a human (§27)"
GET /api/v1/guides/quiet-meals-near-me   404 guide_not_found   (a collection is not a guide)
GET /api/v1/collections?kind=blog        422 validation_error, details.field=kind, allowed=[collection,guide,itinerary]
scripts/check_contract_drift.mjs  served 64 → 68, client-only 29 → 25
```

Nine items across ten citations is the seeded data being honest, not a defect: `build_collections` overlaps its
quiet-hours pick with its Sha Tin pick. It is also why `cards` mirrors the item walk rather than the distinct shop
set — an array one shorter than the list it was built from reads as a lost row.

Still open: the collection/guide payload has no `packages/types` schema yet, so `verify_payload_conformance.mjs`
cannot check these four responses at all (it can only check what the platform already declares);
`GET /api/v1/merchants/{slug}`'s profile still has no published schema (36 top-level keys unchecked); and the
cards these pages embed inherit the §19 rating defect — `rating` renders on 520 merchants while no `facts` row
carries `attribute='rating'`, which is the next thing to fix at the seed layer.


## 23. The rating behind the rendered rating (2026-09-23)

§19: a number a consumer can see has to carry the fact under it. The card prints 「4.3 · 128 則評價」from
`merchants.rating_agg` + `review_count`, `MerchantCards` has joined a `rating` lateral since D25 — and the seeder
wrote no such row. Measured on the seeded tenant:

```
select attribute, count(*) from facts group by attribute
  address=684  capacity=157  cuisine=520  opening_hours=520  price=2080        -- no `rating` at all
merchants rendering a rating: 520
```

The second measurement was the surprise. `having m.rating_agg <> round(avg(r.rating), 2)` named **17 merchants,
every one exactly 0.01 away, every exact mean ending in `.xx50`**. Not bad rows: two rounding conventions.
Python's `round()` is half-to-even, Postgres' `round(numeric, 2)` is half-away-from-zero — and the generator's own
invariant check compared them with `abs(diff) > 0.01`, so `generate.py` printed PASS on a dataset the database
contradicted by a cent. D35 rules on it.

Landed:

- `round2` / `mean2` do the aggregate in `Decimal` with half-up rounding, so the stored value and any SQL
  recompute are the same number by construction; `m2` uses it too, because `merchants.avg_price_hkd` is rounded
  by `numeric` whether Python agrees or not. The `> 0.01` tolerance is gone — a tolerance on an equality the
  database can recompute is where a defect sits, not where it is caught.
- **1,727 rating facts**: 520 merchants and 1,207 offerings, `source='observed'` (the platform's arithmetic over
  its own published reviews, not a merchant's claim), `confidence` banded by sample size (0.70 under 5 reviews,
  0.80 under 50, 0.90 above), a 24h TTL, and a value that carries `count`, `max_score`, `method` and
  `reviewed_through` — the newest review inside the window, which the aggregate column cannot say.
- Six `quality.sql` checks: one fact per reviewed subject and no fact without one, equality with the recomputed
  mean, equality with the rendered column, an evidence window that is not behind its own inputs, a confidence
  that tracks `n`, and the TTL/shape.
- `OfferingRepository` now joins a third lateral and asks for `rating` in `factsOf(...)`. The menu and the
  offering profile printed ratings with no citation beside them; `CatalogReadTest` asserts the fact and the
  printed number are the same mean.
- `CollectionsController` echoes an `items` element that is not an object instead of deleting it, so
  `item_count 4 · items [] · dropped_item_ids []` is no longer an answer this endpoint can give (new test), and a
  `seo.cover` that is not an object degrades to the real `cover_url` (test added against the claim that it
  500s — it did not).

```
bash scripts/db_gate_fresh.sh --keep    159 checks PASS (was 153) · facts 4,661 → 5,688 · 3 runs, exit 0
psql on the kept gate database          rating=1,727 · merchant facts == rating_agg: 520 / 520
mvn -o test                             106/106
```

The gate database was dropped afterwards; neither live database was opened by it. One note on the run itself: two
`mvn` invocations overlapping in `services/platform/target/` produced a `Tests run: 0` surefire crash and a bogus
failure, and a clean single run was green — the suite is only trustworthy one at a time.

Still open:

- The dev `nexus` database still carries the pre-D35 seed, so the running `:8090` serves cards whose `facts` array
  has no rating entry. Reloading it truncates `DEPENDENT_TABLES`, which holds rows other sessions wrote against
  that instance, so the reseed belongs to whoever owns `:8090` rather than to a unilateral call here.
- `packages/types/src/fact.ts` `FRESHNESS_TTL_SECONDS` has no `rating` key, so the TTL table a payload checker
  reads cannot judge a rating fact's 24h window. That file carries another stream's uncommitted edits.
- Two agent reports this hour cited commits (`e0247f4`, `48119f3`), files and line numbers that do not exist in
  this repository — including a whole `services/ai/` tree and `docs/PRD.md`. Every claim was checked against the
  tree before use and none was folded into the ledger; a report whose paths do not resolve here is not evidence
  about this project.


## 24. The seam no gate was watching (2026-09-23)

`quality.sql` proves the rows. `mvn -o test` proves the projection, against fixtures each test inserts by
hand. Neither looked at the pair — so the §19 rating gap survived *both* gates for as long as it existed:
520 merchants rendered a rating, `facts` held no `rating` row for one of them, 153 quality checks passed,
94 tests passed. A gate that stops at a boundary cannot see a defect standing on it.

`scripts/e2e_fresh.sh` crosses it: create an empty database from `template0`, apply `V*.sql` +
`00_roles.sql`, generate and load the seed, boot the platform against *that* database on a free port with
Redis off, then run `scripts/verify_served_reads.mjs` over HTTP and shut everything down. 57 tables,
5,688 facts, 1,727 of them `rating`.

```
=== 6/6  probe the served consumer reads
  · directory cards probed: 20
  · menu offerings probed: 7 (2 rated)
  · published guides: 1
RESULT: PASS — 194 served-read checks passed against http://127.0.0.1:8092
```

Every printed rating on every probed card now carries a fact whose `value` and `count` equal the printed
ones — directory, profile, menu, and the cards embedded in a guide. On top of that the probes hold
`item_count == items + dropped` (§8/D34), that an unreviewed guide answers `noindex` with a reason (§27),
that attribution never invents a curator, and that kind pinning and the 422 vocabulary behave over the
wire rather than in a test harness.

Two defects the run found in its own making, both real and both now fixed:

- **The launcher let `.env` win over the caller.** `run_platform_dev.sh` sources `.env` with `set -a` and
  only *then* applies `${VAR:-default}`, so an exported `NEXUS_PLATFORM_DB_URL` was silently replaced by
  the file's value. The first end-to-end run therefore booted against the live `nexus` database and
  reported 1,727 seeded rating facts as zero — a false FAIL, and it would have been a false PASS on
  whichever database happened to be answering. The launcher now captures the caller's assignments,
  restores them after the source, and prints what it kept; `e2e_fresh.sh` additionally refuses to probe
  unless the running service says it kept *this* run's URL.
- `set -e` aborted the boot wait: the listener probe inside the loop is *expected* to find nothing for
  its first iterations, and a failed command substitution in an assignment is fatal. It needs `|| true`,
  and the nohup'd child's `> "$LOG"` truncated the launcher's own banner away, so the two now log
  separately.

Also fixed while here: `NEXUS_DEV_LOG` / `NEXUS_DEV_PID` are overridable, because this file is how every
session on this machine starts the service and a verification run inheriting `.platform-dev.log` truncates
the log the running instance's owner is reading.

Step 7 then runs `scripts/verify_reservation.py` against the same throwaway instance, because that walk
leaves rows behind and the run that proves a state machine should not mutate the demo data another
session is looking at: `29/29 checks passed`, `reservation: NX-RES-YFAW8M`, capacity `10 -> 8 -> 10`.
Choosing a *priced* slot is what made that leg mean something — both price checks used to compare null
with null off `slots[0]`, and now read `slot=328.00 reservation=328.00` and `slot=328.00 inbox=328.00`.
`--reads-only` skips it.

Still open: no browser has been driven against a throwaway database, so §168's UI journey and the §171
screenshot step remain unproven; the cart/checkout leg has no HTTP surface to walk at all.


## 25. What the seam found on its second day (2026-09-23)

D35 built the crossing; this is what came out of it once the probes stopped asking only the questions
the author already knew the answers to.

**`facts.source` was not a closed vocabulary.** `select distinct source from facts` on the seeded tenant:
`demo, estimated, merchant, observed` — and `estimated` is not a provenance. 171 rows said the platform
had *estimated* a price in the one column whose job is to say who vouched for it, because
`offerings.price_source` (whose domain does include `estimated`, and whose consumer reads it) was copied
straight across. The published `fact.json` schema enumerates six sources and requires the field, §4 ranks
exactly those strings when two claims conflict, and the column is free `text` — so nothing between the
seeder and the contract noticed. D36 rules: the estimate stays in the column that owns the word, the fact
says `inferred`, and `value.estimated=true` keeps it visible inside the citation.

Four structural checks came with it, none of them enforced anywhere before: one fact per
`(subject, attribute)` (the reader does `order by observed_at desc limit 1`, so a duplicate is a coin
toss between two truths), `confidence` inside 0..1 (`numeric(4,3)` stores 9.999 happily),
`expires_at > observed_at`, and `stale` only where the TTL has actually run out. Gate: **163 checks**,
was 159, `RESULT: PASS`, exit 0.

**The end-to-end read chain went from 194 to 204 checks** by following the rating to its evidence:
the card's printed value against `review_stats.average_rating`, its count against `published_reviews`
and against the sum of the star distribution, the rating fact's `reviewed_through` against
`latest_review_at`, and a cursor walk over the review pages proving the listing advances and returns
rows that belong to the merchant and say they are demo. Three of those checks caught *the probe's own*
wrong assumptions before they caught anything real (`review_count` instead of `review_stats.count`, a
distribution treated as a map when it is an array of `{bucket, count, share}`, `status_scope` being a
sentence rather than a token) — each was fixed by reading the served payload, not by loosening the
assertion.

**A money check that compared null with null.** `verify_reservation.py` asserted the reservation restates
the slot's price and the inbox restates the reservation's — 30 green checks, and the walk had booked an
unpriced table slot, because the directory's popularity-sorted first page is all restaurants. 8,513 of
32,492 seeded slots do carry a price; the walk now looks for one and reports
`slot=473.11 reservation=473.11`, capacity `6 -> 4`, replay `200`, anonymous `401`. Where a branch
cannot be reached — the demo owner's own merchant has no priced inventory, so the inbox leg still reads
`slot=null inbox=null` — the evidence now says so instead of looking like a pass.

Also: `e2e_fresh.sh` refuses to run on a port someone else is already listening on, and refuses to
believe a response unless the java process holding that port is the one it started. The first version of
the harness graded a leftover instance from an earlier attempt; that is how a green end-to-end run can
mean nothing.


## 26. Auditing the surface the service says it has (2026-09-23)

The probes so far asked about the routes the author remembered. The service publishes a better list:
springdoc is a dependency, so `/v3/api-docs` is what the *running process* claims to answer. `verify_served_reads.mjs`
now fetches it and hits every declared GET, filling each path parameter with an identifier this run
actually resolved (a merchant slug it just read, an offering from its menu, the guide from §8) and using a
deliberately unresolvable one where nothing exists to address.

The rule that makes that meaningful: **a route is allowed to refuse, but not to be silent.** 401/403 is a
workspace route behaving as designed; a 404 or 422 must carry `error.code` naming what it rejected; a 5xx
or an unnamed 404 is the OpenAPI document advertising something the router does not have behind it.

```
· served surface: 39 declared GETs · 13 answered 200 · 26 failed closed or asked for auth
  · 0 5xx · 0 not really mapped
RESULT: PASS — 525 served-read checks (was 204)
```

Every EntityCard-shaped object anywhere in those 39 responses goes through the §19 check — the sweep walks
the payload tree rather than trusting an endpoint to tell it where it put a card — so a rating printed on a
surface nobody wrote a probe for still has to carry its fact.

Two 500s were reported against this tree while I was building the sweep ("`/api/v1/offerings/{slug}` and
`/api/v1/collections/{slug}` crash on a scalar `seo`"). Both were checked against the code before being
"fixed", and neither exists here: the offering laterals all filter `f.subject_type = 'offering'`, and
`Json.jsonObject` returns an empty map for a non-object column, which is what `coverOf` and `seoOf` build
on. The sweep found 0 5xx. What the dispute was worth is now an assertion rather than an argument —
`CollectionsReadTest.scalarSeoDoesNotBreakTheProfile` inserts a guide whose `seo` is the string
`"not-an-object"` and requires the read to answer from the columns it can still trust, `creator` and
`User curator` from the real author, cover from `cover_url`, and `noindex` because unreadable provenance is
still unreviewed (§27 does not default open).

`mvn -o test`: 107/107. The whole run again from an empty database: 1,727 rating facts loaded, datasource
guard green, 525 read checks, 30/30 reservation checks against a priced slot (`slot=473.11`).


## 27. What the contract promises versus what the process answers (2026-09-23)

`scripts/verify_contract_runtime.mjs` compares `docs/API_CONTRACT.md` against `/v3/api-docs` of a running
service — the OpenAPI document springdoc generates from the annotations the router actually registered.
The drift ledger answers "does any client call this?", which is necessary and not sufficient: a path
literal in a Javadoc comment counts as "served" there. This is the other question — "if a consumer follows
the contract to this URL, is there a handler?" — and it runs against a throwaway instance from
`e2e_fresh.sh --keep`, never a stale jar.

```
contract routes in scope : 79 of 95 documented      (/api/v1 only; §0's /api/nexus BFF rows are proxies)
declared by the service  : 51
absent                   : 28   §3 1 · §5 9 · §6 12 · §8 1 · §9 5
served, not documented   : 27
RESULT: PASS — every documented phase-1 §4/§8 *read* is declared
```

The gate is on reads, deliberately: an undocumented §4/§8 *read* is a page a consumer can be sent to with
nothing behind it, while an unbuilt *write* is a decision — §8's `POST /api/v1/collections` stays absent
until the §27 authorization path exists (D34), and failing on it every run would train people to ignore
the exit code. The 28 absent rows are the §5 workspace surface, the §6 cart/checkout family (its services
exist; no controller has been wired yet), and the §9 admin reads — all roadmap facts, now listed rather
than remembered.

Two things this measurement caught about itself:

- The first version of the parser gave every inline route mention without a verb a `GET`, which invented a
  phantom second method for nearly every documented write: the ledger claimed the service served
  `GET /api/v1/auth/login` and the contract did not. 116 routes in scope and 63 absent were mostly that
  bug; requiring an explicit verb takes it to 79 and 28.
- The sweep raised two false alarms about the service and one true alarm about itself, and it is worth saying which was which. The "500 on `/api/v1/offerings/{slug}`" and "declared but not mapped" rows were my own probe pushing a merchant slug into unrelated templates; checked directly, no offering detail route exists in this build, and the contract does not promise one either, which is the consistent state. The service was never wrong there — the measurement was, twice, in the direction that would have had me fixing a phantom.
- The report capped the served-but-undocumented list at 12 rows, hiding 15. A ledger that truncates is how
  a gap survives being measured.

**Twenty-seven routes were served and documented nowhere; three of them were this wave's own, and the change that measured them documents them.** Those three are `GET /api/v1/merchant/customers` — with its own `source` and `definition` fields, and `all|repeat|new` stated as a *filter* rather than a claim that anything writes a customer segment — the §11 telemetry response, which the contract had shrunk to `202 {accepted, rejected}` when the handler answers `{accepted, rejected, duplicates, reject_reasons, max_batch, note}`, and the surface sweep's identifier rule below. The remaining 26 are not one owner's: they are
`POST /api/v1/events`, `GET/POST /api/v1/me/favorites`, `POST /api/v1/me/preferences`,
`POST /api/v1/me/saved-searches`, `GET/PUT /api/v1/notifications/preferences`,
`POST /api/v1/notifications/{id}/read`, `POST /api/v1/notifications/read-all`,
`POST /api/v1/referrals/invite`, the conversation `reply`/`handoff` family and the merchant-content
photo/hours writes — endpoints whose handlers are in the tree and whose responses are real, documented
nowhere.

That last sentence led to the larger finding of this section: **five platform modules were running green
while git did not have them.** `com.nexus.growth` (mine, tasks #10-#12 — 1,191 lines and two test classes),
plus `com.nexus.admin`, `com.nexus.commerce`, `com.nexus.seo` and three `com.nexus.merchant` files were
untracked, so `mvn -o test` reported 107/107 on a checkout that could not reproduce any of it. A green
suite whose inputs are uncommitted is not a gate; it is a local mood. `com.nexus.growth` is committed by
this section's change. The rest belongs to the waves that wrote them, and is listed here with its paths so
whoever owns each can land it — nobody should have to guess whether the service they are testing matches
the source they are reading.


## 28. Teaching the inventory to read the contract's own shorthand (2026-09-23)

`verify_contract_runtime.mjs` reported "26 routes served and documented nowhere". Fourteen of them were
documentation gaps; the other twelve were the tool failing to read the document. Both sides of that had to
be settled before the list was worth acting on, because a reader who does not know which kind of row they
are looking at will "fix" the notation holes and call the ledger clean.

What the contract actually writes, and what the first parses missed:

- a method cell names several verbs (`GET/POST/DELETE`), and the row may then name several paths after it
  (`| GET | \`/api/v1/me/orders\` · \`/me/reservations\` · \`/me/conversations\` |`) — the second and third
  written relative to the `/api/v1` prefix, which the first parse dropped;
- a span carries its own verb (`· POST \`/api/v1/notifications/{id}/read\``), so cell verbs belong to the
  first path only;
- a span continues past the path into a body sketch (`` POST /api/v1/events {events:[…]} ``), so a pattern
  that demanded the closing backtick right after the path un-documented the routes written that way —
  including §11's telemetry ingest, which the same tool had just told me to go and document;
- `…/offerings[/{id}]` is one route with two spellings, which must be counted as served when *either*
  answers. Collapsing the brackets to the base made every item-only route look like a missing collection
  route and turned 26 gaps into a spurious 47.

The counts are the point of doing this in the open: undocumented-served went 27 → 26 → 20 → 18 → **14**,
and documented-not-served 63 → 28 → 47 → 40 → **38** — the second number landing where the contract really
does promise routes nothing serves (§5 workspace writes, the whole §6 cart family whose services exist with
no controller, §9 admin). A measurement whose movement tracks the reader's comprehension rather than the
system's state is not measuring the system.

Two contract rows were wrong against the code and are corrected here, not just reformatted:

- §3 documented preferences as `GET/PATCH/DELETE /api/v1/me/preferences[/{id}]`. `MeController` answers
  **GET and POST on the collection** and **PATCH and DELETE on one entry by id** — the row invented a
  collection-wide `DELETE`, which would be "forget every preference I have", and omitted the POST that is
  the only way an entry gets there. The rewrite states the four real routes and says why there is no bulk
  erase.
- §3's notification rows never mentioned `GET/PUT /api/v1/notifications/preferences` or
  `POST /api/v1/notifications/read-all`, both served since the M1 wave. They are documented with what the
  service actually returns — `in_app|email|push` filled from the tenant defaults where nothing was stored,
  `editable_channels` naming what a client may send, and `{marked_read}` counting the rows a call changed
  rather than the rows in the inbox.

Writing those rows also produced a notation rule worth keeping: a method cell has to be `GET/POST`, not
`GET · POST` — the `·` belongs between paths, and a row using it between verbs is unreadable to the tool
and ambiguous to a human about which verb binds which path.

Still open, and deliberately not silently absorbed: `POST /api/v1/share` is documented and not served
(added to the ledger's gap list rather than deleted from the contract, because §59-62 want the short link
and it is a decision to drop it, not a formatting fix), and the 14 remaining undocumented-served rows are
mostly `com.nexus.merchant` / `com.nexus.conversation` routes whose owners should write their own rows —
listed with their paths in the tool's output rather than paraphrased here.

The harness now ends with that reconciliation as step 8 of 8, so the contract cannot drift from the router without a gate going red: `scripts/e2e_fresh.sh` runs the reconciler against the same throwaway instance the probes just graded, and a full run is now seed → schema → 525 served-read checks → 30 reservation checks → contract ↔ router, `RESULT: PASS` on one command.

§11 gained the two operational reads it never documented (`GET /api/v1/health` and `/ready`, with the exact fields each returns). The first draft of that bullet claimed both were `no-store`; measured against a running instance, neither sets a `Cache-Control` header at all, so the row now says what is true and why it is fine — §103's `no-store` rule is about money and seats — and why a caller still must not cache the answer: `ready` issues a `select 1` per call, which is the only reason it can ever say `down`.


## 29. Two deliverables nobody could check out (2026-09-23)

While confirming that nothing of mine was left uncommitted, two more turned out to be exactly that:
`scripts/verify_consumer_slice.py` and `scripts/verify_merchant_page.py`, written during the M4 slice work
and never added. They had been *run* — tallies quoted from them appear in earlier sections — from a working
tree that could not be reproduced. Same shape as `com.nexus.growth` earlier the same day, which is the
pattern worth naming: a green measurement made from an uncommitted artefact is not a gate, it is a memory.

`verify_consumer_slice.py` is the §170 walk (platform :8090 + the web prod build on :3002 in live mode,
folding in the merchant-page and reservation-write legs), and it probes the AI service rather than assuming
it: with `:8010` down, those steps report **BLOCKED**, not passed. `verify_merchant_page.py` says its own
limit in its opening lines — the in-app browser's viewport is unavailable here, so the evidence is rendered
HTML plus the JSON it was projected from, which is why §171's screenshot step stays open and the browser leg
waits on the web stream's in-flight route work rather than being declared done.


## 30. The review write door, which was promised before there was a room behind it (2026-09-23)

§6 has listed `POST /api/v1/merchants/{id}/reviews` since the contract was written; nothing served it, so a
consumer could read 11,000 reviews and add none. `ReviewController` + `ReviewRepository` now answer it, with
the three choices D37 records: queued as `pending` with a `moderation_cases` row beside it, moving no
rendered number because the aggregate and its `rating` fact count published rows only (D35), and visit
badges looked up from this caller's own reservations and orders instead of accepted from the body.

The route was tested where the rest of this work is tested — after the harness built a database from
nothing. The first live attempt came back **409 on the first merchant**, and would have come back 409 at
every merchant in the dataset: the synthetic corpus attributes published reviews to the very demo accounts a
session can log in as, so the one-voice-per-place rule was being spent by rows nobody ever wrote. Unit tests
could not have shown that — they invent their own fixtures. The fix is an explicit, narrow exception
(`data_origin = 'demo'` is not anybody's voice) with the reasoning written down, and a test that pins both
halves: the synthetic row still counts in the aggregate, and it no longer buys the silence.

```
mvn -o test                                   115/115 (7 new)
live on the throwaway, basil-leaf-0419         201 · pending · user · verified_*=false · aggregate_changed=false
page rating before / after                     3.79 · 291  /  3.79 · 291
database                                       1 user review, 1 open moderation case
scripts/e2e_fresh.sh                           8/8 PASS (contract ↔ router included)
```

One own error worth keeping: the first version of the aggregate-untouched test posted **without** an
`Idempotency-Key`, so the route 422'd and the assertion "the number did not move" passed on a request that
wrote nothing. It was green and meaningless until the live run forced the key in. A check that cannot tell
"refused" from "accepted and inert" is not a check — same lesson as the reservation walk's `null == null`
money comparisons, learned twice in one day.

Consequence, stated so nobody rediscovers it: this leaves a queue with no door. The rows `ReviewController`
writes can only be published by §9's `POST /api/v1/admin/moderation/{case_id}/resolve`, which the reconciler
lists as documented and unserved — so in the current build a real review stays pending forever, and the
aggregate can only ever move through merchant edits and the seeded corpus. That is the honest state, not a
bug to hide by publishing on write, and it is now the blocking dependency of the review surface: it belongs
to whoever builds §9.


## 31. A trigger that made the trust layer read-only (2026-09-23)

D37 left a queue with no door, and opening it needs one thing: restating a `rating` fact after a review is
published. `update facts set …` answered

```
ERROR:  record "new" has no field "updated_at"
  in PL/pgSQL function set_updated_at() line 2 at assignment
```

V1 walks a list of tables and installs `<table>_updated_at BEFORE UPDATE → set_updated_at()` on each,
`facts` among them, and V1's own `facts` declaration has `created_at` and no `updated_at`. A trigger body is
not validated until it fires, so the schema has been shipping an UPDATE path that cannot run: **no fact row
has ever been updated in any environment of this project.** That is also why `FactRepository.record` is an
INSERT — not a design choice, a workaround nobody wrote down. The accident was load-bearing in the worst
direction: §7, §5, D25, D36 and D37 all describe a facts row that gets restated when the world changes, and
the table forbade it.

- **V6** adds the column the trigger already expected. Three clocks, named: `observed_at` when the value was
  true of the world, `updated_at` when this row was last restated, `expires_at` the deadline.
- **V5** makes one claim one row — dedupe to the newest observation per `(subject_type, subject_id,
  attribute)`, then a unique index. Every reader sorts by `observed_at desc limit 1`, so without this, two
  live rows about one claim is a coin toss; D36's check only ever guarded data the platform did not write.
- **`record` upserts** now: same row, new value/source/confidence/`observed_at`/TTL, `stale=false`.
- **`avg_price` → `price`.** `MerchantService.recordProfileFacts` filed merchant price edits under an
  attribute no reader joins, while `MerchantCards`, the seed, `quality.sql` and `FactAttribute` all use
  `price`. The edit therefore wrote a fact nobody could cite and left the card citing the *previous* price as
  its provenance — a citation that had quietly become false, which is the single thing a trust row must not
  turn into.

`FactWriteTest` (2 new; suite **117/117**): 88.00 → the card's price fact says 88.00; 120.00 → it says
120.00 with **one** row and **zero** `avg_price` rows; and the second observation is the *same row id*,
`stale=false`, `expires_at - observed_at` exactly six hours measured from the new observation. Neither test
could have been written before V6, and the second would have failed without V5.

```
db_gate_fresh.sh   V1..V6 from an empty database · 163 checks · tables=57 migrations=6 · PASS
e2e_fresh.sh       8/8 · 525 served-read checks · 0 5xx · 30/30 reservation checks · contract ↔ router PASS
```

Both migrations were also applied to the shared `nexus_test` incrementally through `db_apply_migrations.sh`
(the script skipped V1-V4 and reported `migrations=6`); the suite cannot see V5/V6 otherwise, since the
tests run with Flyway off.

Operational note, because this changes what the *running* `:8090` can do: that process is an older jar and its
`record` is still a bare INSERT, so a second edit of the same claim (a merchant saving opening hours twice) now
hits `facts_one_row_per_claim_uidx` and answers 500 where it used to quietly grow a second row. The failure is
loud, correct and temporary — restarting `:8090` onto this commit replaces the INSERT with the upsert. Until
someone who owns that instance restarts it, do not exercise merchant edits against `nexus`.


## 33. The review lifecycle, end to end, on data nobody had looked at (2026-09-23)

`scripts/verify_review_flow.py` walks the whole review story over HTTP — sign in as the demo consumer, post
a review, find it in the queue, publish it as a platform admin, and then compare three numbers that must be
one: the rating the card prints, the rating fact that cites it, and the aggregate the reviews endpoint
recomputes live over the published rows. It runs as part of step 7 of the harness, next to the booking
walk, against the database that gets thrown away afterwards.

To make it possible at all, the seed had to grow the thing it was missing: **544 waiting reviews and zero
moderation cases**, so the queue the write path fills answered `[]` on the demo dataset. The seeder now
opens a case per non-terminal review and `quality.sql` binds the pair in both directions, including a check
that the queue is simply non-empty — an empty inbox passes every "nothing is orphaned" assertion while the
product's review process is a fiction. 163 checks became 166.

The interesting part is what the failures taught, because I read them wrong first. Two of six fresh runs
failed the triple-agreement check; the writes were four separate statements, so I wrapped them in
`ModerationService` under `@Transactional` — correct on its own terms, and not the cause. Printing the HTTP
status alongside the numbers showed the profile had answered **404**: the merchant was `pending_review`, and
`{}` (an error envelope) had been read as "a card with no citation". Two real fixes fell out: the queue now
names each case's `merchant.status`, and the walk distinguishes a missing page from a missing citation and
asserts that a review of an unpublished merchant really does stay off the consumer surface. A scan of all
470 published cards found zero card/fact disagreements, which is what proved the data had been fine and my
instrument had not.

```
mvn -o test                       121/121 (incl. the merchant.status assertion)
scripts/db_gate_fresh.sh          166 checks PASS · tables=57 migrations=6
e2e_fresh.sh                      525 read checks · 30/30 booking · 15/15 review lifecycle · contract PASS
scan over every published card    470 scanned · 0 printed-vs-cited mismatches
```

## 34. The workspace had locks, and nothing had a handle (2026-09-23)

§5 documented three routes the platform had machinery for and never answered: who belongs to a business,
which keys it has issued, and whether its AI agent is on. `PermissionService` wrote grant rows,
`ApiKeyService` hashed and listed keys, `MerchantPermissions` held the role presets, and `WorkspaceAccess`
already resolved `member:` and `apikey:` — no controller had called any of them, so §5 documented three doors
and the service answered none of them.

The rule the doors are built on is D5 said a second time: **a membership row is a record, and
`permission_grants` is the access.** So every write here reconciles the two. `permission_grants` has no
foreign key to `merchant_users`, which means the schema will not notice a grant that outlived the person it
was written for — a removal that deleted only the row would leave a signed-in stranger with `write_products`.
`PATCH` moves the rows with the role, `disabled` deletes them while keeping the membership for the trail, and
`DELETE` removes them under both spellings a human grant can be filed as, because the authoriser accepts
either. `MerchantWorkspaceTest` (10 tests) therefore asserts on grant rows in SQL and not only on the status
code: a role change is proved by calling an unrelated route that needs the new permission
(`/api/v1/merchant/customers`), which a no-op reconciliation cannot pass.

Three refusals carry the design, and each is a different kind of harm: demoting, disabling or deleting the
last active `owner`/`admin` answers 409 `last_admin`, because a workspace nobody can administer is only
discoverable when you need it; adding a person who is already a member answers 409 `member_exists` and names
their current role and `PATCH`, because silently re-rolling a role on a typo is how a `staff` becomes an
`admin`; and a `user_id` from another tenant answers 404 `user_not_found` and writes no row — that id is not a
person here, and a 403 would tell an attacker it is somebody's.

Two latent defects surfaced, both in tracked code that had never been executed:

- `PermissionService.grant` guarded itself by asking whether the **subject** held `admin_members` — it asked
  the person being granted to authorise their own granting. It now checks the **operator**, under either
  spelling, keeping the exemption that lets a new owner seed themselves. Its only caller in the whole build
  had been that self-seed, so no second-person grant had ever been attempted to notice.
- `MerchantRepository.updateMember` had no caller either, and its first one produced a 500
  `BadSqlGrammarException`: in an `update … from merchants`, the unqualified `status` was ambiguous against
  `merchants.status`. Qualifying it is the one-line fix; the interesting part is that a documented `PATCH`
  route can be written, compiled and reviewed while returning 500 forever, because no test ever called it.

On the key door: the secret is printed once and only its SHA-256 is kept, each scope is also a
`permission_grants` row for `subject_type='api_key'`, and revoking deletes those rows with it — a revoked key
that still authorised something is a label over a live secret. The controller writes no audit row for
creation, because `ApiKeyService.create` already writes `create_api_key` (name, prefix, scopes; never the
secret), and a second row for the same act makes the trail read as two keys issued. For members the audit
write sits *inside* the idempotent work block, so a replayed `Idempotency-Key` is answered from the stored
response and leaves one `add_workspace_member` row — now asserted, since the flag-on-the-body alternative
would have kept passing if the guard moved outside the block.

Ledger corrections, four of them and two of them mine. `DECISIONS.md` gained
the **D39** heading that commit `492b740` never wrote — the decision was in the tree with no entry beside it.
A row I had added to §5 an hour earlier claimed a `PATCH /api-keys/{id}` that exists nowhere; self-review
caught it, and the row now lists the methods actually served. One pre-existing §5 row had a literal `|`
inside its cell (`all|repeat|new`), which splits that row into five columns when anything renders the table;
escaped, and the pattern is now worth knowing before a row is written.

The fourth is the one worth writing down, because it is about the reader rather than the document.
`verify_contract_runtime.mjs` reads verbs from the method cell and
applies them to every bare path span, and it accepts a relative span only if it starts with `/merchant`,
`/me`, `/admin`, `/ai` or `/notifications`. So a row written the way §5 had always written them — `` POST
`/members` · PATCH/DELETE `/members/{id}` `` — documented *nothing*: the relative span matched no prefix rule
and the item form was never reached. All seven workspace routes I had just built therefore appeared in the
report under **"served, not documented"**, which is precisely the shape the script's own closing warning says
a hole in the reader takes ("this parser has been wrong twice, and a hole in the reader looks exactly like a
hole in the document"). Each span now carries its own verb and a full path, the documented total moved from
118 to 121, and the seven parse with the methods they are. A contract that a tool cannot read is not a
contract the build can be audited against, whatever the prose says.

```
mvn -o test                     138 run · MerchantWorkspaceTest 10/10 · 1 red, untracked com.nexus.admin
scripts/e2e_fresh.sh            8/8 · 525 served-read checks · 0 5xx · 30/30 booking · 15/15 review · contract PASS
verify_contract_runtime.mjs     121 documented (was 118) · 84 declared (was 80) · 16 → 12 "served, not documented"
```

None of the seven appears in either mismatch list, which is what "documented and served" has to mean before
it can be claimed.

The `com.nexus.admin` failure is not this work's: `AdminConsoleApiTest.searchAnalyticsReportsRealCounts` is
untracked (`git ls-files` on that test directory returns nothing), fails in isolation, and its repository
mixes `sum(v.sessions)` from a view with `count(distinct session_id)` — an owner-side count disagreement,
reported to whoever is writing that package rather than fixed from outside it.

No migration changed this round, which is also why `db_gate_fresh.sh` was not re-run: the schema is the one
§31 certified, and `ai_agent_enabled` is the only AI setting it carries. That is why the config route refuses
a persona, model or temperature it has nowhere to put and says so in `scope_note`, rather than adding a
column to make the request look good.

This surface has been verified the way a backend surface can be: HTTP against a booted Spring context, on a
database built for the run and thrown away after it. There is no merchant-console screen calling these routes
yet, so the browser leg (§156) is still open and belongs with task #9, not here.

One numbering note, so nobody wastes a minute on it: this entry is §34 because §33 is the last section the
file holds — there has never been a §32 in `STATUS.md`, and `DECISIONS.md`, which numbers independently and
is up to D40, is the authoritative ledger.

## 35. A gate that could not read the notation the contract is written in (2026-09-23)

§34 ended with a documentation bug found by reading a report. This one is the same bug seen from the other
side, and it was larger.

`verify_contract_runtime.mjs` defines `forms()` — the function that expands the contract's optional-id
shorthand, `…/offerings[/{id}]`, into the collection form and the item form, with a comment explaining that a
documented route counts as served when *any* spelling answers. Nothing called it. The line above had already
cut the path at `[`, so by the time `forms()` might have run there was no bracket left to expand.

What that cost, measured against a live instance rather than reasoned about: `PATCH` and
`DELETE /api/v1/merchant/offerings/{id}` and `DELETE /api/v1/me/saved-searches/{id}` — three routes that are
annotated, registered and answering — sat in **"served, not documented"**, while the reader invented
`PATCH /api/v1/merchant/offerings` and `DELETE /api/v1/merchant/offerings` and `DELETE
/api/v1/me/saved-searches` — a patch and a delete against an entire collection, which nobody wrote and nobody
can serve — and reported *those* in **"documented, not served"**, as a broken promise by the service. Two
wrong lists with one cause, and each of them points at a different innocent party: the first at whoever
"forgot" to document their route, the second at whoever "forgot" to build it.

Splitting on whitespace only, and letting `forms()` do the job its own comment describes, moves the same
run from 84 declared / 25 gaps / 12 undocumented to **87 / 22 / 9** with the documented totals unchanged
(121, 109 in scope) — three routes recognised, three phantoms retired. None of the three offerings or
saved-searches paths appears in either list any more.

The safety leg did not get weaker, and that is worth pinning because loosening a reconciliation is exactly
what an improvement like this can smuggle in: the run fails only on a phase-1 §4/§8 **GET** that is documented
and not served, and the only two bracketed rows in the whole document are §3 and §5. So no §4/§8 read can now
be satisfied by "some other spelling of mine answered". Verified by checking which rows the notation touches,
not by assuming the change was small.

The remaining nine "served, not documented" entries are reported, not repaired, and that is a deliberate
stop — but they were classified rather than guessed, by running the reader against an empty router so its
own extraction is all that shows. Six of the nine are the reader failing on two more notations the document
actually uses. `| GET | \`/api/v1/me/favorites\` · POST \`/api/v1/me/favorites\` · DELETE
\`/api/v1/me/favorites/{type}/{id}\` |` puts the second and third verbs *outside* the backticks, and the
reader only recognises a verb that is inside them — so it attributes `GET` to all three spans, loses the POST
and the DELETE, and invents a `GET /api/v1/me/favorites/{type}/{id}` gap that nobody promised. The same
mechanism hides `POST /api/v1/notifications/{id}/read`. The third case is a continuation:
`` POST `/{id}/reply` `` on the merchant conversations row is relative to the base path above it, and matches
none of the reader's prefix rules, which is why `reply` and both `handoff-resolve` routes come out as
undocumented. And `/.well-known/ucp` is served, documented in §20's bullet list, and dropped because the
absolute-path test is `/^\/well-known\b/` — with no leading dot, so it can never match the host-root path UCP
discovery actually fetches.

Three are the document's own gaps, and they belong to whoever owns the route: `GET /api/v1/reservations/{id}`
(§5 documents only the `PATCH`), `POST /api/v1/auth/session`, and `POST /api/v1/conversations/{id}/handoff-resolve`
on the consumer side, where §7 documents `reply` and not the resolve. Those rows — and the four notation
classes above them — sit with streams whose files are still uncommitted in this working tree. Whether the gate
should learn continuations and out-of-span verbs, or whether those authors should write each path out in full
the way §5's workspace rows now do, is a decision to make on purpose; a bystander making it silently while
fixing something else is how a reconciliation quietly stops reconciling.

```
verify_contract_runtime.mjs, live :8094     84→87 declared · 25→22 gaps · 12→9 undocumented · 121 documented unchanged
scripts/e2e_fresh.sh after the fix          8/8 · 525 served reads · 0 5xx · 30/30 booking · 15/15 review · step 8 87/22/9
```

One read-back worth recording from the same hour: `@Idempotent` was checked in `AuthorizationInterceptor` to
confirm the interceptor only *requires* the header and never claims the key itself. The claim
`MerchantWorkspaceController` makes inside `idempotency.run` is therefore the only one — had the interceptor
inserted the row too, its own `in_progress` status would have made the controller's second insert lose, and
every workspace write would have answered 409 `request_in_progress` on its first call.

The lesson generalises the D40 one, which is why it gets its own section rather than a line in §34. A helper
that is defined, commented and never called is indistinguishable from a feature that was never built, and it
fails in the direction that makes *other people's* work look wrong: the defect here spent its time reporting
three shipped routes as undocumented and three nonexistent routes as unbuilt promises. When a ledger disagrees
with the build, the cheapest hypothesis to test is the ledger's own reading of the document — which is the
sentence the script prints at the bottom of exactly that list, and which has now been right a third time.

## 36. The gate learned four notations, and the document had nowhere left to hide (2026-09-23)

§35 stopped at a boundary on purpose: six of the nine "served, not documented" entries were the reader
failing to parse the contract, three were the contract genuinely missing rows, and *who should move* — the
gate or the document — was left as an open question rather than settled by whoever happened to be fixing
something else. This round settles it, in **D41**, and then does both halves of the work.

Four notations API_CONTRACT.md already uses were invisible to `verify_contract_runtime.mjs`. All four were
found by running the reader against an empty router, where its own extraction is the only variable:

- **A verb outside the backticks.** `` | GET | `/api/v1/me/favorites` · POST `/api/v1/me/favorites` · DELETE
  `/api/v1/me/favorites/{type}/{id}` | `` — the reader only honoured a verb *inside* a span, so it handed the
  row's `GET` to all three paths. That lost a POST and a DELETE the document promises and invented
  `GET /api/v1/me/favorites/{type}/{id}`, a gap nobody wrote. `POST /api/v1/notifications/{id}/read` was
  hidden by the same rule, and mis-labelled as a GET.
- **A continuation.** Line 220 is `` `/api/v1/merchant/conversations` · POST `/{id}/reply` · POST
  `/{id}/handoff-resolve` ``. `/{id}/reply` matches none of the reader's absolute-prefix rules, so the two
  write doors of the merchant inbox documented nothing — the same failure §34 hit in the workspace rows, this
  time in a file that was not mine.
- **The leading dot of a host root.** The absolute test was `/^\/well-known\b/`. UCP discovery fetches
  `/.well-known/ucp`, dot included, so the pattern could not match the only spelling that exists; §20's
  bullet was invisible to the reconciliation, and since the service does declare it, the route sat in the
  bucket that accuses the document.
- **A brace alternation.** §9 writes `` `GET /api/v1/admin/{users|merchants|orders|reservations|reviews|
  reports}` `` — six literal paths, compactly. `norm` collapsed every `{…}` group to `{}`, which is exactly
  right for a parameter (`/users/{id}` and `/users/{slug}` are one handler) and exactly wrong here: it
  retired five of the six promises and left the reconciliation reporting a gap on `/api/v1/admin/{}`, a path
  no router can hold. `alternatives()` now splits the group before `norm` sees it, so each of the six has to
  answer on its own. This is also why the two notations must not share a rule: `[/{id}]` is one route with
  two spellings and passes if *either* answers; `{a|b}` is two routes and both do.

The safety leg is the part worth re-reading before trusting a single number below, because "the gate was
wrong" is the most convenient thing to say when a gate catches you. Every one of these four changes can move
the verdict in **one direction only**: a newly recognised documented path is an extra route the build must
answer for, and a retired phantom is a promise the document never made. None of them lets one route satisfy
another's promise — the any-spelling rule stayed confined to bracket optionals, and the only two bracketed
rows in the whole document are §3 and §5. The hard gate still fails only on a phase-1 §4/§8 **GET**, and none
of the four notations appears in §4 or §8; checked against the document, not assumed from the size of the
diff.

Then the residual, which is the point of repairing a gate at all: three routes the platform serves and the
contract did not document. All three are in tracked code, which makes them this ledger's job rather than a
note to a neighbour, and each row was drafted by reading the method that answers rather than from the
report's line:

- `GET /api/v1/reservations/{id}` (§6) — the holder, or a subject holding `read_orders` on the booking's
  merchant; anyone else gets `404` and not `403`, because a `403` would let a booking code be probed.
- `POST /api/v1/auth/session` (§3) — the resolved principal of the credentials that just authenticated. No
  write, no audit row, no idempotency key, which is the whole difference from `/me`.
- `POST /api/v1/conversations/{id}/handoff-resolve` (§7) — `accepted` or `resolved`, `409 no_open_handoff`
  when there is nothing to close, audited against the handoff's own `reason`.

```
mvn -o test                       138 run · 1 red (untracked com.nexus.admin, unchanged from §34) · 0 of them here
scripts/e2e_fresh.sh              8/8 · 525 served-read checks · 0 5xx · 30/30 booking · 15/15 review · contract PASS
verify_contract_runtime.mjs       121→133 documented · 109→121 in scope · 87→96 answered · 22→25 gaps · 9→0 undocumented
```

The gate is honest in one direction and that is the whole point of repairing it rather than editing it: the
gap list got **longer** by three on the run that closed the other list to zero, because splitting §9's
alternation replaced one collapsed entry with six routes and all six are unbuilt. The single
`GET /api/v1/admin/{}` line had been both a phantom promise and an excuse for six missing handlers, and every
earlier run of this gate had counted it as one gap.

What the twenty-five remaining "documented, not served" rows are not claimed to be: correct by inspection.
They are what the reader extracts and the router does not answer, and this time the six §5 entries were
checked at the source rather than excused — `grep` across every controller in the tree, tracked and untracked
alike, finds no mapping at all for the merchant analytics, campaign, approve-publish, coupon, knowledge-base
or reindex routes, so they are unbuilt, not mis-read. §6's eleven cart and payment doors, §9's six admin
reads and §8's two writes are the same kind of fact with a count on it, which is the honest shape for a
roadmap.

The two lists are no longer symmetric in usefulness, and this round is the reason to say it plainly:
"served, not documented" went to zero, so the document now accounts for every route the running service
declares. What remains on the other side is work, and it is now safe to read as work.

## 37. The doors were built, tested and documented, and nobody in the demo could open one (2026-09-24)

D40 wrote the workspace doctrine and §34 built the nine §5 routes that apply it. What nobody had done was ask
the one table that decides access whether the demo had any rows in it. On the live `nexus` database, measured
before this round touched anything: **3** active `owner` memberships, **0** holding a live `admin_members`,
**15** human grant rows, **12** of them carrying an `expires_at`. Every one of §5's doors — members, api-keys,
the AI switch — answered 403 for the only merchant humans the dataset contains, and `MerchantWorkspaceTest`
stayed green throughout, because each of its tests seeds the permissions it needs. A fixture that supplies its
own access can prove what happens when access exists. It cannot prove that it does.

The seed now writes the role's preset rather than a hand-picked five, so a seeded owner holds all twelve
permissions `MerchantPermissions.OWNER` names: **15 → 36** human grant rows, **0** of them expiring, **3/3**
owners able to administer their own business. That is D42, and the part of it worth carrying forward is the
reading of an existing check rather than the new one: `quality.sql` has asked *"does every seeded owner
membership have grants?"* since it was written, it has been passing the whole time, and it was telling the
truth about a dataset nobody could use. A check for the presence of something cannot catch the wrong thing
being present. The new check names the permission the door needs.

The second finding is smaller and worse. `GET /api/v1/me` has printed `"permissions": []` for every membership
since the route was written — a placeholder in a position where a consumer expects a list, which is more
damaging than the field being absent, because absent is a question and empty is an answer. It now reads from
`PermissionService.grantedToHuman`, the union over both spellings a human's grants are filed under, which is
also what the roster reads; `MerchantWorkspaceService`'s private copy of that union and of the spelling list
is deleted, so a screen and a roster cannot drift into describing one person's access differently. Human
grants carry no `expires_at` at all now, and a quality check refuses any that do: a role is assigned, only a
key or an agent leases.

The new `scripts/verify_workspace_flow.py` (22 checks, wired into `e2e_fresh.sh` step 7 as the third walk)
starts from the button a visitor presses — `/api/v1/auth/demo`, role `merchant` — and ends on the claim D5 has
always made: the key that walk creates answers 200 on a `read_analytics` route, `last_used_at` is stamped, the
stored row shows only a prefix, and one request after revocation the *same* bearer token answers 401
`invalid_api_key` while the human roster is untouched. Access lived in the grant rows, and that sentence is
now measured rather than asserted. Also measured, because a permission system is mostly a list of refusals: a
foreign workspace answers 403, a stranger's `user_id` answers 404 and writes no row, and disabling the last
admin answers 409 `last_admin` without having disabled anything.

```
mvn -o test                       139 run · MerchantWorkspaceTest 11/11 · 1 red, untracked com.nexus.admin
scripts/db_gate_fresh.sh          166 → 168 quality checks · PASS on a from-scratch schema
data/seed permission_grants       15 → 36 rows · owners with admin_members 0/3 → 3/3 · lapsing human grants 12 → 0
scripts/e2e_fresh.sh              8/8 · 525 served-read checks · 30/30 booking · 15/15 review · 22/22 workspace · contract PASS
verify_contract_runtime.mjs       133 documented · 121 in scope · 96 answered · 25 gaps · 0 undocumented (unchanged from §36)
```

The one red is the same one §34 and §36 reported — `AdminConsoleApiTest.searchAnalyticsReportsRealCounts`,
untracked, another wave's in-flight Admin Console, and an `expected 2L but was 3L` count disagreement that no
permission change this round can reach. The contract ledger did not move either: this round added no route and
changed no mapping, so the reader's numbers are §36's, and the 25 rows still standing there are still each
owner's work rather than noise.

Two things this round did **not** do. It did not reload the demo data: the instance on :8090 and the `nexus`
database behind it still hold the old fifteen rows, so the console someone is looking at right now is still
the locked one — restarting a service this session does not own is that owner's call, and the two fresh gates
build their own databases precisely so this is the only honest sentence available. And it did not open a
browser: there is still no merchant-console screen calling these routes, so §156's visual leg stays with
task #9 and `apps/web`'s dirty state, rather than being claimed here on the strength of an HTTP walk.

## 38. Four authorisation reads branched on a clock that nothing in the repository could set (2026-09-24)

D42 deleted twelve `permission_grants.expires_at` values from the seed, on the argument that a deadline nobody
assigns is a role that quietly vanishes on a Tuesday. The deletion was right, and it left something behind that
only a measurement shows: `expires_at` now appears in **four** authorisation reads — `hasMerchantGrant`,
`hasTenantGrant`, and both arms of `grantedPermissions`, each carrying
`(g.expires_at is null or g.expires_at > now())` — and in **none** of the four writers: three
`insert into permission_grants` statements in the service and the seed's COPY row, which passes `None`. The
table where a deadline would make the most sense cannot hold one: V1's `api_keys` has `last_used_at`,
`revoked_at` and no expiry column, so a merchant key is revoked, never expired. `AGENT_CONTRACT` §8 nonetheless
states "Grants expire (`expires_at`)" as a requirement — a sentence that was, until this section, untestable in
either direction.

So the predicate was mutated, twice, on a throwaway copy of `PermissionService`, with `MerchantWorkspaceTest`
run against each edit and the file restored immediately after:

```
drop `g.expires_at is null or` from all 4 reads   → 11 of 12 tests red (the load-bearing arm: it gates everyone)
invert the comparison at all 4 reads              → 1 of 12 red — and that one is the test D43 adds
```

The second row is the reason for the section. A reversed deadline still admits every grant whose `expires_at` is
null, and every grant the whole system had ever produced had exactly that, so the mutation survived all eleven
tests that existed an hour ago while serving 200 to a call that should have been refused and 403 to a key with a
day left on it. `MerchantWorkspaceTest.anExpiredGrantOpensNothingAndIsNotPrinted` now dates a grant in both
directions — past, present and future — and asserts the same row both stops opening doors and stops being
printed by the two doors that print access, then revives with no write in between; its fixture at
`MerchantWorkspaceTest.java:446` is the only place in the repository that puts a non-null deadline on a grant,
and it fails if the row it aimed at was not there.

What that measurement corrected, beyond the missing test: `PermissionService`'s class javadoc claimed the table
is authorisation's single source of truth "for humans, merchant API keys and AI agents alike". The AI half is
not how this build works — the agent path is `AiServiceTokenGuard`'s shared `X-Internal-Token` (D12), a platform
staff call is `@RequiresPlatformRole` reading the token's `role` claim, and no read anywhere asks for a row
filed as `subject_type = 'agent'`, though V1's column comment and §8 both name it. The comment now says which
doors this table opens and which two it does not, which also supersedes D42's closing clause about where
deadlines "mean something". Two printed surfaces follow: §3's `/api/v1/me` row names `memberships[].permissions`
and the reader behind it (D42 made that field load-bearing while the row still read "summary"), and
`GET /api/v1/merchant/api-keys` now says in its own `note` that nothing but a revocation ends a key.

```
mvn -o test                       140 run · MerchantWorkspaceTest 11 → 12/12 · 1 red, untracked com.nexus.admin
mutation witness                  is-null arm 11/12 red · inverted comparison 0/11 → 1/12 red
grants carrying a deadline        0 → 1 writer, in a test fixture (nothing in main or seed sets one)
scripts/db_gate_fresh.sh          168 quality checks · PASS on a from-scratch schema (unchanged)
scripts/e2e_fresh.sh              8/8 · 22/22 workspace · contract PASS, ledger unchanged from §37
```

What stays open, deliberately: no TTL was invented. Putting an expiry on a key needs a migration `api_keys` has
no column for, a write path, and a product decision about a secret that stops working on a clock nobody set —
D34's precedent says record that rather than build it, and §8's sentence is that document owner's to amend. The
:8090 instance and the `nexus` database behind it are still on pre-D42 rows. The browser leg is still task #9.
And `AdminConsoleApiTest.searchAnalyticsReportsRealCounts` is red again, same `expected 2L but was 3L` at line
289, in the untracked `com.nexus.admin` work — reported, untouched, and unreachable from anything here.

## 39. Five comments cited a decision that never said it, and a gate now exists for the door nobody can open (2026-09-24)

Two things moved in the platform's permission layer since §38, one forward and one backward.

Forward: `PermissionVocabularyTest` asks the running Spring router which permissions its guarded routes name,
and requires each to be inside the union of the seven role presets and `API_KEY_SCOPES`. That is D42's failure
mode expressed as a subset relation — a route guarding a permission no preset contains can never be opened by
anyone, and every other signal around it (a 200-able controller, a contract row, a green unit test) stays quiet.
It is reflection, not grep, because the claim is written two ways in this codebase (`"read_analytics"` and
`MerchantPermissions.READ_ANALYTICS`) and only the evaluated annotation is what the interceptor compares. The
assertion carries the four permissions whose absence broke the demo as its non-zero guard, so a router that
registered nothing cannot pass it.

```
mutation                                                   test reddened
"configure_ai" → "configure_ai_unheld" on a route          enforcedPermissionsAreAllGrantable
merchant = "apikey:id" → "keyid:id" on a route             merchantScopesResolveOrFailAsAClientError (a 500)
```

Both were run against the file in place and restored, with a `grep -c` on the tree afterwards. The second row is
the one that justifies the second test: `WorkspaceAccess` answers an unknown `merchant()` kind with
`ApiException.internal`, so a mistyped prefix in an annotation turns a documented, RBAC-declared route into a
500 — 27 specs across 8 kinds are declared in the working tree, and the test checks them by asking the resolver
itself rather than by carrying a copied list of prefixes, which would go stale by passing.

Backward, and the reason this section is mostly about prose: five comments in three packages
(`RequiresPermission`, `PermissionService`, `MerchantWorkspaceController`, `MerchantWorkspaceService`,
`MeController`) stated that `permission_grants` is authorisation's source of truth **because D5 says so**. D5 is
"Auth & tenancy" — JWT and the session cookie, no card data, the `tenant_id` predicate, 404-instead-of-403 — and
the string `permission_grants` appears in it **zero** times. The other sixteen D5 citations in the service are
correct, and every one of them is about tenancy, enumeration or card data, which is exactly what makes the five
wrong ones hard to see in a review: they look like the other sixteen. The source is D40's own sentence "**The
rule the doors have to honour is D5.**", which the comments were faithfully copying; §38's commit re-created a
copy in the same edit that removed one. All five now cite D40, and D40 carries an amendment line directly above
the offending sentence rather than having it rewritten, so the log keeps what was believed on 2026-09-23 and the
correction sits where a copier would pick it up.

```
mvn -o test                       142 run (140 → 142) · PermissionVocabularyTest 2/2 · MerchantWorkspaceTest 12/12
                                  1 red, untracked com.nexus.admin, unchanged
principal construction sites      2 (`user` in AuthFilter, `api_key` in ApiKeyService.verify) — `Principal`'s
                                  javadoc had been claiming all four grant-table spellings were subjects
routes guarded by a permission    9 of the 12 vocabulary names in the working tree · 4 of them from tracked code
```

`Principal`'s comment went the same way as §38's `PermissionService` one: it declared its `subjectType` domain
as `user | merchant_user | agent | api_key`, which is the column's vocabulary, not the set of subjects this
build authenticates. `merchant_user` is a spelling a row is filed under — which is why D40's union is over rows,
not principals — and `agent` has no reader. What that measurement also exposes is `AuthorizationInterceptor`'s
branch for a principal that already reports `merchant_user`: no authenticator can produce one. It is left in
place and named here, because narrowing the authoriser on the strength of a comment is how a gate starts
accepting less than it appears to.

Two deliberate omissions. The reverse check — "every permission a preset grants is guarded by some route" — was
not written: five of the twelve are enforced today only by another wave's untracked controllers, so an
expected-set table built from this shared tree's disk state would change verdicts when that work commits or
reverts; that is D41's empty-router trap in reverse, and `create_reservation`, `create_draft_campaign` and
`publish_campaign` stay in §5's "documented, not served" ledger with their owner. And no seed, schema, route or
contract row changed in this section, so the two fresh gates were not re-run — a SQL gate cannot observe a new
unit test or a corrected comment, and `mvn -o test` is the gate that covers both. :8090 and its database are
untouched, and the browser leg is still task #9.

## 40. A route that stored its answer for replay never required the key the replay is stored under (2026-09-24)

`POST /api/v1/admin/moderation/{id}/resolve` wraps its decision in `IdempotencyService.run`, which claims a row
keyed by scope plus the caller's `Idempotency-Key` and, on a conflict, returns what the first claimer stored. It
did not carry `@Idempotent`, the annotation that makes `AuthorizationInterceptor` demand that header. So a
resolve with no header was not un-idempotent: it claimed `moderation_resolve|null`, and every keyless caller of
the route shares that one row. All three consequences were run against the shipped code rather than reasoned
about — the first answered 200 and wrote the shared claim; a later keyless resolve by a different platform
account answered 409 `idempotency_key_conflict`, locking a second reviewer out for the TTL; and the same
account's next keyless resolve is answered from the stored row without executing, which `IdempotencyPairingTest`
measures at the service because the HTTP door no longer admits it. That last face is the one that would have
hurt: a console printing a decision, a `resolved_at` and a before/after pair for a case nobody decided.

```
marker on the route            422 naming the header and the scope; nothing claimed, closed or audited
guard in run()                 null or blank key → 500 that names the declaration it wants (measured with the
                               marker deleted: the same request answers 500, loud instead of shared)
IdempotencyPairingTest         new · 2 tests · the scan walks src/main/java, not the router
ModerationFlowTest             4 → 5 · suite 142 → 145 · the 1 red is com.nexus.admin's, unchanged and theirs
replays in this build          5 (review, events, member, api_key, moderation_resolve) · all paired
§1's five named doors            1 of 5 is served and requires the key · 4 served replays were not in the list
```

`mvn -o test` is 145 run with the one external red, and because a live door's requirement changed the fresh walk
was re-run too: `scripts/e2e_fresh.sh` PASS on :8092, its review phase still publishing and still refusing a
second decision (`scripts/verify_review_flow.py` sends a key on every resolve, which is why the new 422 is a
guard rather than a breakage), and the ledger unchanged at 121 of 133 documented in scope, 96 declared, 25
documented-not-served, 0 served-undocumented.

The gate is a source scan, which is the one place this project deliberately does not ask the router: which
handler wraps its body in `run` is a fact about a method body, invisible to reflection, and the two halves of the
promise sit centimetres apart inside one file. It opens by asserting the source directory exists — a scan whose
root moved would otherwise pass by finding nothing — and it runs in one direction on purpose. A `@Idempotent`
with no `run` asks for a token it does not use; `POST /api/v1/reservations` is the served, honest neighbour of
that shape, since `reservations_slot_user_uniq` (V2) settles a retried booking: the route returns the same code
at 200 instead of 201, and `reused` is recorded in its audit payload. A `run` with no `@Idempotent` corrupts an
answer, and only that is refused.

`docs/API_CONTRACT.md` §1 was where the wrong list came from: it named checkout, payment, reservation create,
review create and campaign publish, and `Idempotent`'s javadoc had copied those five verbatim (D44's mechanism
with a section number instead of a decision number). The paragraph now states the five replays this build
answers, where a retried booking gets its protection, and which three doors are still unserved.

Two things this does not touch. `IdempotencyService.headerOnly` builds a string, not a claim, so it is unguarded
by design: when `com.nexus.commerce` grows the checkout route it will need this marker or its own decision about
a null key, and that is that stream's call. And `AuthorizationInterceptor` was not edited — the enforcement it
already performs is what this unit builds on, and it belongs to the other wave. What is *not* a code question is
the row the shipped route wrote into whichever database it ran against: `idempotency_keys` can still hold a
`moderation_resolve|null` claim, and nothing in the build deletes it. §40 wrote that the row "expires on its own
within the TTL", and §41 is the unit that found the sentence had no code behind it: no reader compared
`expires_at` with the clock, in this table or in the deployment. The new test deletes that literal before it
counts rows, so the gate measures its own request rather than history; nothing here rewrites a deployed table.

## 41. A deadline nobody reads is not a deadline, and a config key nobody opens is an offer withdrawn in silence (2026-09-24)

`IdempotencyService.run` writes `expires_at = now() + nexus.idempotency.ttl-seconds` onto every claim. Before this
section nothing compared that deadline with a clock: at D45's commit four files name `idempotency_keys` and exactly
one line mentions its `expires_at`, the insert (the pattern the project already uses for `facts` — §20's freshness
TTL is a companion read, `f.expires_at is not null and f.expires_at < now()` in `FactRepository` — this table simply
never got one). D45's §1 sentence ("refused until the TTL ends"), D45's own decision entry and §40's closing
paragraph all described the deadline as if it did something. It did not, and the consequences were run against the
code as it then stood by deleting the new read again:

- a claim left `in_progress` by a process that died between the insert and the update has only one exit — the
  delete inside `run`'s `catch` — so every later retry of that key answered 409 `request_in_progress` for the life
  of the row, and the only way out was an operator's `delete`;
- a `completed` claim replayed past its window, so `NEXUS_IDEMPOTENCY_TTL=60` and `=600000` were one service;
- a second account colliding on a key was refused `idempotency_key_conflict` forever, not "until the TTL ends".

The fix is three lines and no janitor: an insert that loses to an existing row asks whether that row is still
inside its window, drops it if not, and tries to own the key again; the re-insert is still `on conflict do nothing`,
so a concurrent retrier that loses falls into the branch that already existed and reads `in_progress`. A live claim
behaves exactly as before, which is the half mutation 2 checked — with `and expires_at < now()` deleted, all three
new tests go red, because a stealable live claim is the double execution the table exists to prevent. There is no
sweeper: this service has no `@Scheduled` method or scheduler bean at all, and a timer that deletes rows behind a
request's back is the same species of unhoused promise this unit is about. So the window is enforced lazily by
whoever touches the key next — every correctness face is closed, and what is left is that an abandoned row stays on
disk past its window and costs storage. It cannot cost an answer. What a retried expired key then runs again is
guarded by the resource: `case_already_resolved` (D39), `reservations_slot_user_uniq` (V2), and for `reviews`,
nothing — a review reposted after its key expired is a second review, which is what a day-later second post is.

`ConfigDecorationTest` is the same defect one level up. It walks the top-level `nexus:` tree in
`src/main/resources/*.yml` by indentation and asks, per leaf, whether any `@Value` in `src/main/java` names it. The
first run found `nexus.deletion.grace-days` unread, and the reason matters more than the key: `DELETE /api/v1/me`
tells its caller "a deletion_request row was created for the retention job (§106)" while this build has no
retention job, so the 30 days record an intention nothing holds. Building that job means scheduling irreversible
data destruction, which is a human decision rather than a default, so the key is exempted with that reason written
into the test and the gap is reported here. An exemption has to keep paying for itself: non-blank reason, still
declared, still unread.

```
IdempotencyWindowTest            new · 3 tests · red ×3 with the read deleted (M1) · red ×3 with the predicate widened (M2)
ConfigDecorationTest             new · 1 test · 25 nexus.* leaves declared · 24 of them read · 1 exempted with a reason
                                 and 10 keys read by code but declared nowhere, which the gate lets stand on purpose
mutations run                    4 (M1 read off · M2 predicate off · M3 exemption misnamed · M4 parser root renamed)
suite                            145 → 149 run · the 1 red is com.nexus.admin's AdminConsoleApiTest:289, unchanged and theirs
```

The tests age a claim with `update … set expires_at = now() - interval '1 hour'` instead of sleeping or of
configuring a one-second TTL, because the window is a fact about that column: a sleep is not a test and a short TTL
measures the property binding, not the read. `age` asserts it updated exactly one row, since an update matching
nothing is silent — D43's rule that a predicate needs a witness that can fail, applied to the test's own plumbing.
And the `in_progress` row the abandoned-claim test writes is written in the shape `run` writes, which is what makes
it a faithful stand-in for a killed process: `run` is the only thing in this build that inserts that status.

Two things this does not do. It does not add a `CHECK` on `idempotency_keys.status` — V1 has none, and a hand-typed
status now stops refusing callers at the deadline rather than permanently, which is the same deadlock removed one
layer down instead of the vocabulary fixed. It does not build §106's retention job, does not touch
`AuthorizationInterceptor` or `headerOnly` (another wave's), and does not change a route, a seed row or a schema,
so the contract ledger is §39's, unchanged — which is what the fresh walk confirmed after the read landed:
`scripts/e2e_fresh.sh` PASS on :8092, 121 of 133 documented routes in scope, 96 declared by the running service, 0
served without being documented, and the reservation, review and workspace walks green (each sends its own
`Idempotency-Key` per run, so no walk ever crossed an expiry). The four suites that exercise a stored replay over
HTTP — moderation resolve, review write, workspace members and api-keys, events ingest — were run again with the
three platform gates above after the last edit: 40 tests, 0 failures. `:8090` is still not listening — nothing on this machine runs the platform right now — and the browser
leg is still task #9.

## 42. A rung no request ever produced, and the identity the caller was allowed to type (2026-09-24)

§1 has printed `429` + `Retry-After` + `X-RateLimit-Remaining` since that document's first commit (`7591852`) and
`RateLimitFilter` has sat on `/api/v1/*` since the day it was written (`e237f6d`). Neither had ever
happened where this build is checked. The measurement, taken before anything was added:
`rg -n "429|TOO_MANY_REQUESTS|rate_limited" services/platform/src/test/java` → **zero hits** in 149 tests, and the only
occurrence of `ratelimit` under `src/test/java` at all was `NexusIntegrationTest` setting
`nexus.ratelimit.enabled=false`. Every test that ever walked through that filter did so with the filter disarmed,
which is the whole reason a promise can survive unnoticed: the gate is not missing, it is
switched off by the fixture that was supposed to exercise it.

The 429 was the easy half. What made this a security unit is the bucket's key.

- `Req.clientIp` returned the first `X-Forwarded-For` entry whenever a caller sent one, and that value keyed the
  login brute-force window — so the gate that exists to stop a password guess did not stop the guess, only the
  address the guesser chose to name. Met on the pre-D47 configuration, which
  `ForwardedHeaderTrustTest` keeps running on purpose (limit 1): four failed logins → one refusal and three
  handler visits, the window refilling every time the claimed address changed, and two attempts naming
  `203.0.113.11` enough to spend that address's window before its real holder arrives. How much of that last
  clause is measurement and how much inference, and why one machine cannot close the difference, is D47 §4's. A
  header was both an escape hatch and a way to spend someone else's budget.
- One line of configuration did the same thing underneath the application: `application.yml:5` declared
  `server.forward-headers-strategy: framework`, which registers Spring's `ForwardedHeaderFilter` and overwrites
  `getRemoteAddr()` with that header for **any** peer. Had this unit only fixed the Java, the fix would have
  been cosmetic. Nothing in `docs/`, no comment and no test explained why that word was there.
- And the same string was written into `audit_logs.ip`, a Postgres `inet` column, by
  `AuditService.record` — a method that catches every exception on purpose, because a broken audit write must not
  turn a real action into a 500. So `X-Forwarded-For: not-an-ip` made `cast(:ip as inet)` fail, the row for the
  event that had just happened disappeared, the caller still got their response, and the only trace was one
  `audit_write_failed` log line. That is measured in both directions now: the framework class asserts the login
  answered 401 and its tenant has **zero** audit rows; the fixed path sends the same value and asserts the row
  exists and holds `127.0.0.1`. An untrusted header had been both the identity and the switch for whether the
  trail exists.

The fix is two lines, one of them in a config file: `clientIp` answers with the socket peer and reads no header,
and the strategy becomes `${NEXUS_FORWARD_HEADERS_STRATEGY:native}`. The word was chosen from the mechanism, not
from memory — asking the running container with `native` set shows `RemoteIpValve` in the engine pipeline, and
the default `server.tomcat.remoteip.internal-proxies` (read out of Boot 3.5.16's own configuration metadata,
matching the regex compiled into tomcat-embed-core 10.1.55) is the loopback, private, CGNAT and link-local
ranges. So a caller on the public internet typing an address gets nothing, while a proxy the operator declared
still names clients — which is what `DeclaredProxyTest` keeps true, so that "untrusted" remains a policy and not
an accidentally removed feature. The two classes send the same requests and get different answers, and the only
difference between them is that declaration. A third gate reads the shipped files: any
`forward-headers-strategy` in `src/main/resources/*.yml` must resolve to `native` or `none` and must be
`${ENV:default}`, because that is the only thing standing between this fix and a one-word edit back.

```
ClientIpTest                     new · 1 test · reads the method directly, so no header can be a peer
RateLimitEnforcementTest         new · 3 tests · first 429 this repository ever produced; 7 attempts → 3 audit
                                 rows proves the refusal sat in front of the route; opens with a probe that
                                 fails loudly if the parent harness's enabled=false ever wins the precedence
ForwardedHeaderTrustTest         new · 3 tests · pre-D47 default reproduced (bucket refills, trail disappears)
                                 + the shipped-config gate
DeclaredProxyTest                new · 1 test · what a declared proxy still buys, both in the bucket and in ip
mutations run                    5 · clientIp→header · strategy→framework · Retry-After deleted ·
                                 write bucket keyed per IP · window refuses one late
suite                            149 → 157 run · the 1 red is com.nexus.admin's AdminConsoleApiTest:289, unchanged and theirs
e2e                              9 steps now. The service declared its own auth window as 100 per address (not
                                 the 10 application.yml advertises) and refused the ladder on attempt 95. The
                                 ledger is §41's, unchanged: 121 of 133 documented routes in scope, 96 declared
                                 by the running service, 25 documented-not-served, 0 served-undocumented
```

Three reds in this unit belonged to the unit's own tests rather than to the product, and all three are worth
keeping in mind. A `@TestPropertySource` value loses its backslashes on the way to the container, so the proxy
pattern `127\.\d{1,3}…` arrived as `127.d{1,3}…` and matched nothing (these patterns are now escape-free). An
`inet` cast to text renders `127.0.0.1/32`, so the address assertions read `host(ip)`. And the rung step added to
`scripts/e2e_fresh.sh` laddered twelve attempts against the 10-per-300s window `application.yml` advertises, saw
no refusal, and died — because the profile that script boots under, `application-dev.yml`, re-declares
`auth-requests` as a bare literal `100` ("generous, so manual curl sessions do not get throttled"). The step now
asks the running service for its window via its own `X-RateLimit-Limit` header instead of assuming one. That
third red is the find of the unit: under the dev profile, `NEXUS_RL_AUTH`, `NEXUS_RL_WRITE` and `NEXUS_RL_AI` set
nothing at all, which is §41's "offer withdrawn in silence" one layer up — the key is read by code, but a profile
overrules the environment without saying so — and it is now task #32, with a gate for the class of it rather than
a patch for these three lines.

What this does not do. It does not witness the `ai` scope — no test drives `/api/v1/ai/**` with the limiter on,
so those 20-per-60s numbers are read from the config rather than from a refusal. It does not remove the trust
`native` gives to peers inside the private ranges — that is what the declaration means, `infra/` runs no proxy,
and an operator who exposes this port directly while keeping the default list is making a choice this section
documents rather than one it can prevent from here. It does not harden the audit path itself: `AuditService`
still swallows a failed write, so any future untrusted value that reaches a typed column can still delete a row
quietly — the fix was to stop feeding it caller-chosen addresses. The sibling header reads were checked and
judged different in kind, all four bounded or public by design: `X-Request-Id` is `[A-Za-z0-9._-]{1,64}`,
`X-Session-Id` is `[A-Za-z0-9_-]{8,64}` and names a cart, `User-Agent` lands in a truncated `text` column, and
`TenantFilter`'s use of `X-Forwarded-Host` only ever selects a tenant that `X-Tenant` can select outright (§1
makes choosing a tenant public; choosing an *address* is not). It does not delete `RateLimiter.require`, which
has no caller in this build. It does not touch `rate_limit_buckets`, the V1 table no SQL and no Java here writes
while another stream's types cite it as provenance twice (`packages/types/src/admin.ts` for an admin metric,
`packages/types/src/errors.ts` for a bucket scope key that in this build is a `KeyValueStore` key and never a
row). It does not narrow the dev profile's 100-per-address window it just learned about — §43 is that follow-up,
env-backing all four closed offers and gating the class of them. And it leaves the standing
reports where they were: `com.nexus.admin`'s red test, §106's missing retention job,
`@RequiresPlatformRole`'s thin coverage of the newer admin doors, the 25 documented-not-served rows, task #9's
browser leg (`:8090` still not listening — re-checked for this section) and task #17's reservation transitions.

## 43. A profile that closes an offer the base file makes (2026-09-24)

§42's new e2e step failed on its first run, and the failure is the reason this section exists. It laddered
twelve failed logins against the 10-per-300s window `application.yml` advertises, waited for the 11th to be
refused, and was not; asked for its own window through `X-RateLimit-Limit`, the running service said **100**.
`application-dev.yml` — the profile `run_platform_dev.sh` defaults to, so the profile every local instance runs
under — re-declares the rate-limit quantities as bare literals. A profile document outranks the base file for the
whole environment, so `auth-requests: 100` silently beats `${NEXUS_RL_AUTH:10}`, and the operator who exports the
name the base file prints gets the literal with nothing said about it. D46 was a key no code read; this is a key
code reads through a file the operator cannot reach.

Walking the profile's whole `nexus:` tree, measured rather than estimated: six leaves, all six re-declaring
something the base file backs with an environment name, and four of them closing the offer — the three rate
windows and `demo.login-enabled`. The fourth is the one that matters beyond tuning: `nexus.demo.login-enabled`
is the switch that turns §87's passwordless demo sessions off, the base file offers it as
`${NEXUS_DEMO_LOGIN:true}`, and dev pinned it to `true` — so on the machine that runs the demo, the switch that
disables the demo could not be disabled. Nothing caught that, because the pinned value equals the default; a
closed offer is invisible until somebody tries to take it up.

The four are now `${NEXUS_RL_AUTH:100}`, `${NEXUS_RL_WRITE:300}`, `${NEXUS_RL_AI:100}` and
`${NEXUS_DEMO_LOGIN:true}` — same defaults, dev's generosity kept, environment back in play. Two gates hold it
open. `ConfigDecorationTest` gained a second test that walks every profile file and refuses a leaf which the base
file offers as `${ENV:…}` being re-declared as a bare literal, with a non-empty-profile guard and a
positive-overlap guard so it cannot go green by comparing nothing. The overlap guard needed its own witness and
finding it took two tries: the first mutation, stripping `${}` from the four base leaves, left the gate green,
because `nexus.redis.url` and `nexus.jwt.secret` overlap too and the guard still had two comparisons to stand on;
renaming the profile's whole `nexus:` block is what makes it speak, on its own line with its own message.
`DevProfileRateLimitTest` boots with `@ActiveProfiles("dev")`
and `NEXUS_RL_AUTH=2` and asks the service instead of the file: it printed `X-RateLimit-Limit: 2`, refused the
third attempt, and recorded two handler visits for three requests. Reverting one dev line reddens both classes
together.

```
ConfigDecorationTest       1 test → 2 · profilesKeepTheEnvironmentInPlay + two vacuity guards
DevProfileRateLimitTest    new · 1 test · the dev profile and an operator's variable, measured over HTTP
mutations run              3 · dev leaf → literal (both classes red) · demo switch → literal (gate red) ·
                           profile's nexus: block renamed (overlap guard red, on its own message)
suite                      157 → 159 run · the 1 red is com.nexus.admin's AdminConsoleApiTest:289, unchanged and theirs
e2e                        PASS on the restored config: the service still declares its own window as 100 per
                           address (defaults untouched), refused the ladder on attempt 95, reads 525 checks,
                           walks 30/30 + 15/15 + 22/22, ledger unmoved at 121 of 133 in scope / 96 declared /
                           25 documented-not-served / 0 served-undocumented
```

One correction made on the way, and it is worth its own sentence because the mistake is the house's oldest: §42's
new §1 sentence named both prefixes the `ai` scope matches, and a citation copied is a citation multiplied (D44).
`/api/v1/ai/**` is a path family this service documents as never served — §7's own row for
`/ai/v1/search/stream` says so in as many words — so that scope is charged by exactly one reachable door,
`/api/v1/merchant/ai-agent`. §1 now says that, and what the unreachable prefix is doing in a shipped filter, plus
the related fact that `ai_unavailable(503)` — §1's other rung — has no witness anywhere in `src/test/java` either,
is D49's opening rather than a fix to smuggle into this one.

What this does not do. It changes no default: a dev boot still starts at 100/300/100 and demo login is still on,
so nothing served moves for anyone who exports nothing. It does not decide that a profile may never pin a value —
a deliberate pin is legitimate, and when one arrives it has to be added to the gate with a reason, the way
`UNREAD_BY_DESIGN` makes its exemptions pay; there is no exemption list yet because none is needed. It does not
reach `spring.*` or `server.*` leaves, only the `nexus:` tree. And it leaves the standing reports where §42 put
them: `com.nexus.admin`'s red test, §106's retention job, `@RequiresPlatformRole`'s thin admin coverage, the 25
documented-not-served rows, `RateLimiter.require` with no caller, `rate_limit_buckets` cited by another stream's
types and written by nothing here, task #9's browser leg and task #17's reservation transitions.

## 44. A filter line that could only ever meter a 404, and the rung behind another stream's door (2026-09-24)

`RateLimitFilter` charged its `ai` scope on two prefixes. One is served — `POST /api/v1/merchant/ai-agent/config`
— and the other, `/api/v1/ai/`, is a path family this service disclaims twice in its own tree: `OpenApiConfig`
names the AI surfaces as `(/ai/v1/**, /mcp, /api/v1/ai/**)` "belong to the AI service", and §7 of the contract
states "the platform service never serves `/api/v1/ai/**`". Asking the running router for its registered patterns
says the same. So the line could meter nothing but requests that then 404, while §1's phrase "AI-ish endpoints
per principal" read as if there were AI endpoints here to protect. D47 propagated that reading: its §1 sentence
listed both prefixes because it copied them from the filter instead of asking the router — D44's failure arriving
in prose — and §43 caught the copy. This unit removed the source and gated the shape.

The gate is `RateLimitScopeRoutesTest`: it reads every `path.startsWith("…")` literal out of the filter's source
rather than keeping a list of its own, asks `RequestMappingHandlerMapping` what is registered, and refuses a
prefix with no route behind it. It guards against its own vacuity twice over — the literal list must be
non-empty, the router must report more than fifty registered paths — because the obvious way for this gate to stop meaning
anything is a refactor that moves the strings into constants, where the reader would find none.

Writing the scope's HTTP witness produced a fact no document had: **a mutating request to the AI-agent door is
charged to two windows at once**, `ai` and `write`. The first version of the test POSTed there and was refused on
attempt two — by the write window (`1` per window in that class), not by the `ai` window it set out to measure.
It now uses a non-mutating request so the scopes cannot collide, and §1 states the overlap, since "one request,
two budgets" is otherwise something a client learns by hitting it.

`ai_unavailable(503)` — §1's other rung — had never been produced anywhere either, for a different reason than
the 429 had. Its only raisers are two `catch` blocks in `HeuristicImportAdapter.fetch` (tracked, this build's),
and every door that reaches them is an untracked file belonging to another live stream. So it gets a seam
witness instead: an unroutable source answers 503 `ai_unavailable`, an internal host answers 422 before anything
is dialed, and a non-http scheme answers 422 — all three in one test, so the 503 cannot be satisfied by a
DNS-rebind guard that grew teeth enough to refuse everything. The reachability gap is reported, not closed by
editing somebody else's controller.

```
RateLimitScopeRoutesTest      new · 1 test · literals from the filter, paths from the router, two vacuity guards
ImportSourceRungTest          new · 1 test · 503 / 422 / 422 at the adapter seam
aiScopeCountsPerPrincipal     new method in RateLimitEnforcementTest · the scope is a principal's window
mutations run                 5 · prefix re-added · ai line deleted · ai bucket keyed per address · 503 branch
                              answers a different rung · all prefixes moved to constants (the guard's witness)
suite                         159 → 162 run · the 1 red is com.nexus.admin's AdminConsoleApiTest:289, theirs
e2e                           PASS with the dead line gone: 525 reads, the three walks at 30/30 + 15/15
                              + 22/22, the rung refused on attempt 95 of the service's own 100-wide window,
                              and the contract ledger unmoved at 121 of 133 / 96 / 25 / 0
```

Two of the five mutations misfired before they fired, and both are worth keeping in the record: the first 503
mutation did not compile (`ApiException.validation` takes a details map), and the constants mutation stayed green
twice — once because only one of three literals had moved, once because the mutation had not moved any. A green
you did not expect is a measurement you have not finished.

The same file got one piece of hygiene, and it came from asking a question rather than assuming the answer:
D47's ladder step pipes curl's headers through a character-deletion whose operand had become a **real** carriage
return byte instead of the two-character escape — the backslash was lost on the way through the script that
wrote it. It worked (which is why two green runs never noticed), but it is invisible to a reader and it makes a
line-ending audit of a script that `.gitattributes` pins to LF come back dirty. The operand is now the
backslash-and-letter form, checked by a byte count of zero and by re-running the whole gate.

What this does not do. It does not decide whether this service *should* serve `/api/v1/ai/**` — that is a routing
question about the §7 BFF split, and a filter line is not the place it gets answered. It does not produce the 503
over HTTP, for the reason above. It does not change how a two-scope request is charged, only says so out loud.
And the standing reports are unchanged from §43's: `com.nexus.admin`'s red test, §106's retention job,
`@RequiresPlatformRole`'s thin admin coverage, the 25 documented-not-served rows, `RateLimiter.require` with no
caller, `rate_limit_buckets` written by nothing here, task #9's browser leg (`:8090` still not listening) and
task #17's reservation transitions.

## 45. A door no test ever opened, and the two things it hid (2026-09-24)

`grep -rn "favorites" services/platform/src/test/java` → nothing. Three documented handlers and a §7 row whose
description cell was empty: the row promised nothing, so the handlers could not contradict it, and the door stayed
unopened from the commit that wrote it (`e237f6d`, the platform's first wave) to today. `FavoriteDoorTest` walks
it — save, list, re-save, remove, cross-tenant refusal, unsupported type, unauthenticated — and the walk turned up
two defects that reading a response shape would never have surfaced.

A favourite may now only point at something the caller could actually open. `assertSubjectInTenant` used to accept
any collection in the tenant, while §8's read path hides rows that are not published *and* attributable, so the
favourites list could hold a card whose link answers 404. Correction, self-reported, because the first version of
this paragraph claimed those rows were demo data: the 31 public-with-no-`published_at` and 31 stamped-but-
unattributable collections I counted (of 576) live in `nexus_test`, the shared test database the suites write
into — the same residue that caught §41. The seed's own number is in the file that loads it,
`data/seed/out/22_collections.sql`: **4 rows**, all stamped, all with an author. So this was a guard missing on a
shape the demo does not currently produce, and it matters because `collections` still accepts that shape today
(`visibility` defaults to `public`, `published_at` is nullable, and D34's gate is a read filter rather than a
constraint): the first write path that lands — §8's own `POST /api/v1/collections` — makes a saved 404 reachable
without anything else changing. Second: `FavoriteBody`'s pattern advertises `guide` while the validator had no guide branch, so the
fourth documented value answered 422 — a DTO promising what the code beneath it denies.

The rule was not copied, it was asked. `CollectionsRepository` already composes its list, its count and its
by-slug read from one scope, one ordering and one provenance gate, so it now answers the same question for
`MeController` as `isPublishable(tenant, id, kind)`; the kind is part of the question, which is what makes
saving a collection id as a guide a refusal rather than a promise kept by accident. The refusal carries the
merchant branch's exact code and message, because D5 forbids a 404 that leaks existence. The test asks the door
and the directory about the same three rows and requires them to agree — one rule, two callers, no drift.

```
FavoriteDoorTest    new · 4 tests · the whole door, plus the publishability and kind agreement with §8's reads
mutations run       4 · check switched off (2 red) · wrong kind passed (guide red) · audit deleted (red) ·
                    on-conflict refresh removed (red)
suite               162 → 166 run · the 1 red stays com.nexus.admin's AdminConsoleApiTest:289
e2e                 PASS, ledger unmoved (121 of 133 in scope, 96 declared, 25 not served, 0 undocumented) —
                    this unit added no route, it closed a validator and filled an empty contract row
§7's row            the empty description is now a written contract, including that the POST answers 200
```

Two things this unit deliberately left alone. The **200**: `/reviews` and `/merchant/api-keys` answer 201 for a
created row and this door answers 200, silently, with nothing in §7 saying which — the row now records what the
code does, and changing a status a client has been reading since the route landed is a contract decision, not a
cleanup, so it is reported rather than fixed under foot. And the **§8 write** it stumbled into: the sentence
explaining why `POST /api/v1/collections` is unserved blamed its absence on the workspace permission chain, which
the schema cannot express — `collections` has `tenant_id` and `author_id` and no merchant column at all. §8 now
carries the measured reason, and the question behind it (who owns a published guide: platform, author, or a
merchant once the table can name one) sits next to `POST /api/v1/share`'s missing link table as task #34, which is
a decision to make, not a route to wire.

Standing reports unchanged: `com.nexus.admin`'s red test, §106's retention job, `@RequiresPlatformRole`'s thin
admin coverage, the 25 documented-not-served rows, `RateLimiter.require`, `rate_limit_buckets`, task #9's browser
leg and task #17's reservation transitions.

## 46. Two doors that reported success they had not earned (2026-09-24)

§45's door method was an accident, so this time it was a count: every `@*Mapping` path in the platform, its last
literal segment, and whether that string appears anywhere under `src/test/java`. 87 `/api/v1` paths, **80 named,
7 not** — `POST /api/v1/auth/logout`, the three `/api/v1/me/saved-searches` verbs, `ucp.json`, and two merchant
routes that belong to other streams. The four identity doors are now walked; the numbers above are the audit, and
the audit is not a gate (a route can be "named" by a test that asserts nothing about it).

Two of the four were reporting successes they had not earned. `removeFavorite` and `deleteSavedSearch` took the
row count from their repositories, threw it away, and answered `{"status":"removed"}` either way — so un-saving
an id you never saved was a success, and un-saving somebody else's row was a success *while their row stayed*.
Both now answer the same `404 …_not_found` / "No such record" that an absent id gets, which is what D5 requires
and what stops the doors being used to ask whose items exist. `FavoriteDoorTest` and `SavedSearchDoorTest` each
carry the survivor check: the owner's row must still be there after the attempt.

`logout` was the other kind of gap — three mechanisms behind three words ("clears session"). Measured: both
cookies return cleared, the refresh family really is revoked so the next `/auth/refresh` is a 401, the audit row
is written for a principal and skipped for an anonymous caller, and **the access token keeps authenticating until
its own `exp`**, because nothing consults revocation for a JWT. §3 now states all of that, including the part
nobody closes: a server-side denylist would live in Redis when reachable and in one JVM's memory when not, which
is D46's silent offer wearing a security label, so the 900-second expiry is the mechanism and the contract says
so instead of implying a kill switch.

Along the way, `TokenRegistry.accept`'s inline comment described the opposite of its code ("accept once and
adopt it, so a store flush does not lock users out") where the code refuses an unknown family — which is what the
class javadoc, the README and mutation 5 all agree on. The comment went; the behaviour was already right.

```
LogoutDoorTest        new · 3 tests · family+cookies+audit, the bearer that survives its logout, the anonymous call
SavedSearchDoorTest   new · 3 tests · the door, its defaults, and 404s that read alike
FavoriteDoorTest      4 → 5 tests · the favourites door's matching 404
mutations run         5 · 404 guards reverted · revoke() dropped · cookie clearing dropped · logout audit
                      dropped · accept() made to fail open
suite                 166 → 173 run · the 1 red stays com.nexus.admin's AdminConsoleApiTest:289
```

What this does not do. It does not close the bearer window, and no longer writes as though it did. It does not
walk `ucp.json` (tracked, service-tested, never HTTP-tested) or the two untracked merchant routes — counted, not
borrowed. (§47 walks the UCP one the same day.) It does not connect the saved search's `notify` to anything: nothing in this build reads that column,
so §7 records the wish and stops there, which is the door's remaining half-promise. Standing reports unchanged.

## 47. The seam that was covered by mocks (2026-09-24)

§46's count left one in-lane route: `GET /api/v1/merchants/{slug}/ucp.json`. It did not look untested —
`UcpProfileServiceTest` runs four green cases — but all four stub `jdbc.firstForTenant(…)` with a hand-built row,
including the one that produces the 200 document, so the service that owns the door had never answered for it.
D49 was a filter line matching no route; this is its milder cousin, a promise with tests that cannot fail.

Asked over HTTP against the real database, the seam is honest and empty. `/.well-known/ucp` returns
`status: not_integrated`, empty `capabilities` and empty `payment_handlers`, and a `merchant_profiles` pointer
that resolves against a route this build serves — the part a mock cannot check. The merchant door answers
`404 ucp_profile_not_published` with the row an integrating agent would need, so the absence explains itself.
Underneath both: **nothing in this repository can turn that 404 into a 200.** No migration, seed file, service or
endpoint writes `agent_profiles`; the table is empty in a migrated database and the only "published" profile in
the build is a stub. That is consistent with the documented Phase-4 hand-off, so no behaviour was wrong — three
sentences in `docs/UCP.md` were: "Nothing here is live today" (true of the adapter plan, false of the endpoints),
and §2's per-merchant path spelled `/api/v1/merchants/{slug}/.well-known/ucp` where §1, §10 and the code all say
`ucp.json` — an agent integrating from that document would fetch a path nothing serves. Both now say what the
build does; the *choice* of canonical spelling stays the open decision it was, with a test binding the printed
pointer so the two cannot drift silently.

The third case asserts `select count(*) from agent_profiles` is zero. It reads oddly — proof that something does
not exist — and it is the mirror of §46's overlap guard: the claim "this seam has no publisher" is the kind that
stops being true without announcing itself, and the morning it does, the door's 200 case is the one that must get
written. An assertion chosen to break at that moment is cheaper than a mock that keeps passing through it.

```
UcpDoorsTest    new · 3 tests · origin honesty + the pointer followed, the explaining 404, the empty table
mutations run   3 · pointer renamed (red) · status claims "integrated" (red) · 404 details stripped (red)
suite           173 → 176 run · the 1 red stays com.nexus.admin's AdminConsoleApiTest:289
```

No production code changed here, so `scripts/e2e_fresh.sh` is not owed: its own rule is a live route's behaviour
or requirement, and §1's route table, the served payloads and the ledger are exactly as §46 left them. What this
does not do: it does not choose the discovery path, does not build the publisher, and does not touch
`toProfile`'s published-but-empty-capabilities 500 — unreachable from any door today, and a question to settle
with the publisher rather than in passing. One new standing report: `UcpProfileServiceTest` is four honest unit
tests of a document builder, and must not be read as coverage of the endpoints.

## 48. A sentence the payload printed and nobody read (2026-09-24)

The census for "printed but never asserted" says the obvious metric is useless: 563 snake_case keys come out of
`Json.map(`/`out.put(` in the platform, 272 of them named by no test and no verifier — but payload conformance
covers many of those and internal metadata inflates the rest, so the ratio is not 272 defects. Picked by meaning
instead: the fields whose only job is to assert a compliance fact.

`authorisation_basis` is one of those. Every member write answers with "permission_grants (admin_members checked
against the caller before this write ran); roles only choose which grant rows exist" — D40's doctrine shipped in
a body so a screen need not infer it from status codes — and nothing tested it. The sentence lived in one helper,
`withBasis`, which two of the three doors called; `DELETE /members/{id}` built its own response and never went
through it, although it checks the same permission as the add and the edit. One caller therefore learned the rule
and two did not.

The string is now a single constant, the removal answers with it too, and
`MerchantWorkspaceTest.theStatedBasisIsTheEnforcedOne` asserts it on all three doors and ends by reading the
removed member's `permission_grants`: empty. That ending is the part that matters — a payload that preaches
"grants are the access" while the rows outlive the membership would pass every string-only check in the file. Two
mutations (drop it from the removal; rewrite the sentence to blame the role column) both went red. §5's member row
names the field, which it never had.

The sweep's second find is a report, not a change: `PaymentService` prints `card_data_stored: false` with the
§42 notice, in another stream's untracked package, and no controller in this build serves a payment route — which
is exactly why §6 lists `POST /api/v1/checkout` and `POST /api/v1/payments/{}/confirm` as
documented-not-served. The reassurance currently reaches no client. That is not wrong behaviour; it is a
compliance statement waiting for the doors that would carry it, and it belongs to whoever builds them.

```
MerchantWorkspaceTest   12 → 13 tests · the basis on all three member writes, and the grants really gone
mutations run           2 · sentence dropped from the removal · sentence rewritten to blame the role column
suite                   176 → 177 run · the 1 red stays com.nexus.admin's AdminConsoleApiTest:289
```

Standing reports unchanged, plus this one line for §6's side of the payment seam.

## 49. The launcher's list of names to keep, and the three it forgot (2026-09-24)

D48 ended with a claim that an operator's `NEXUS_RL_AUTH` now reaches a dev boot. One layer up, the same question
was still unanswered: `scripts/run_platform_dev.sh` sources `.env` with `set -a`, and protects the caller's own
exports by capturing a hand-typed list of names and re-exporting them afterwards. The list held eleven names. The
config reads thirty-four. Of the 24 it missed, three are set in this machine's `.env` right now —
`NEXUS_JWT_SECRET`, `NEXUS_LOG_LEVEL`, `NEXUS_DB_ROOT_PASSWORD` — so `NEXUS_JWT_SECRET=… 
scripts/run_platform_dev.sh` printed `caller overrides kept over .env: none` and booted on the file's secret.
Demonstrated against the real launcher with `mvn` stubbed: before, the JVM-to-be saw `.env`'s 64-character
value; after, it sees the caller's. The variable in the whole tree whose silent substitution is a security
event was the one the list forgot.

Widening the list also exposed a second problem in the same eight lines: the diagnostic printed the captured
pairs as `KEY=value` on stderr, which `e2e_fresh.sh` redirects into its log — so a guard standing between an
exported password and `.env` was busy writing that password to a file. Nothing leaked on this machine, because
nobody here exports a password on the command line; the mechanism was the finding.

Both halves are fixed by removing the list: the names are read out of `application.yml` and
`application-dev.yml` with one `grep -hoE '\$\{[A-Z][A-Z0-9_]{2,}'`, and the echo prints names only.
`ConfigDecorationTest.launcherKeepsEveryConfiguredOverride` reads the real script and refuses either regression —
a hand-typed `for key in NEXUS_…` block coming back, or the printed variable being given values again. Two
mutations, both red: the previous launcher fails the derive assertion, and re-adding `=${!key}` to the printed
variable fails the echo assertion.

```
ConfigDecorationTest   2 tests → 3 · the launcher's keep-list must come from the config, and print no values
launcher               names derived from the two yml files; 11 hand-typed → 34 readable; values no longer echoed
mutations run          2 · old launcher (derive red) · printed variable given values (echo guard red)
e2e                    PASS — and it is what caught the one thing this change took away: the datasource check read
                       the old `KEY=value` echo as its evidence, so the launcher now prints `datasource=…` in
                       its banner (a JDBC URL with no credential in it) and the gate greps that instead
suite                  177 → 178 run · the 1 red stays com.nexus.admin's AdminConsoleApiTest:289
```

What this does not do: it does not check that an exported name exists — `NEXUS_RL_AUT=5` is still silence, and a
typo is still a typo. It does not touch `Makefile`'s `dev-platform` target — another stream's file, still on
:8080, which is what `run_platform_dev.sh`'s own header says it exists to avoid. And it does not change
`.env`, which stays what it is: a
gitignored, per-machine file that now definitively sits *below* whoever typed the command.

## 50. A 401 is not an answer: the codes no request had ever produced (2026-09-24)

The platform emits 61 error codes; 33 of them were named nowhere under `src/test/java` or the `scripts/`
verifiers. Each hides behind a status a test may already assert, so the suite can be green on `401` while a client
cannot tell "expired — refresh it" from "that is a refresh token — don't" from "this session belongs to another
tenant — sign in elsewhere". Three repairs, one status: the code is the only part that says which.

D55 named eleven, each by doing the thing rather than calling a factory. A truncated token and a tampered
signature (same `invalid_token`, different messages, deliberately); a token signed with the real key whose `exp`
is in the past (`token_expired` — real signature, because an unsigned token is refused for the wrong reason and
the test would still pass); a refresh token presented as a bearer (`wrong_token_type`); a session whose `tid`
belongs to another tenant (`tenant_mismatch`, with the same token proved still working at home so the refusal is
about the claim and not the fixture); `email_taken`; `invalid_refresh_token`; then `member_exists` — whose details
are asserted to name the role already in place, because a 409 a screen cannot act on is a shrug — plus
`member_not_found`, `api_key_not_found`, `subject_not_found` and `preference_not_found`, the last two compared
against each other so two different absences cannot share a code. Four mutations, all red: expiry and
cross-tenant each reduced to the generic code, the 409 dropping its `role`, and the key authoriser falling back to
bare `not_found`.

22 remain unnamed. Thirteen live only in untracked files (`cart_*`, `order_*`, `insufficient_stock`,
`reservation_not_addable`, `offering_not_purchasable`, `listing_not_publishable`, one admin `conflict`) —
reported, not walked. Nine are this lane's with real doors, and two of those are config-gated rather than hard to
reach: `not_implemented` fires only when `NEXUS_AI_INTERNAL_TOKEN` is unset, which the shared harness always
sets, and `invalid_id_token` needs a token the dev OAuth verifier can parse. A queue with reasons, not a mystery.

The census nearly lied once: splitting "this lane vs another stream" by matching walked paths against
`git ls-files` returned *zero* for this lane on Windows, because `os.walk` yields backslashes and `ls-files`
forward ones — it called `subject_not_found`, committed hours earlier, somebody else's code. The mistake pointed
in the convenient direction, which is exactly how the project's own rule puts it: a measurement that matches
nothing reports success. Normalising separators turned 0 into nine.

```
AuthRefusalCodesTest  new · 7 tests · the auth family by doing it, and §1's envelope on a refusal
MerchantWorkspaceTest 13 → 14 · three workspace absences named; the 409 says which role
FavoriteDoorTest      5 → 6 · subject_not_found vs preference_not_found, distinct
mutations run         4 · codes: 61 emitted, 33 unnamed before, 22 after
suite                 178 → 187 run · the 1 red stays com.nexus.admin's AdminConsoleApiTest:289
```

What this does not do: it asserts no message prose anywhere (codes are the contract surface; pinning wording just
makes wording hard to fix), it does not gate "every code must be named" — that freezes a list which legitimately
grows — and it changes no ladder rung: every §1 status has been produced by a real request since §42 and §44.

## 51. Six of the nine, and the three that turned out to have no door (2026-09-24)

§50 left a queue of nine codes "in this lane, behind real doors". Six now have a request behind them, and the
three that do not are the part worth reading, because the reason is absence rather than effort:
`offering_not_found` and `slug_taken` are raised only for routes that live in `MerchantContentController`
(untracked, another stream's), and `review_not_found` needs a moderation case whose `subject_id` matches no
review row — cases and reviews are written together, so that branch is an internal-consistency guard, not a door.
Which means §50's count was of *files in this lane*, not of *doors a test can knock on*; a census cannot tell
those apart, only reading the callers can. That is recorded here rather than quietly rewritten in §50.

The six that did land:

- `conversation_not_found`, asserted twice on purpose — the consumer's read, and the merchant authoriser's
  `conversation:id` lookup — both the same 404, because a 403 at either tells a stranger the thread exists (D5).
- `no_open_handoff`, where the assertion already existed and checked only the 409. Naming the code is the
  difference between "nothing left to resolve" and "someone else wrote first", which are two different button
  states on a merchant's screen.
- `notification_not_found` and `moderation_case_not_found`, the same upgrade from status to code.
- `invalid_id_token`, which the default test profile cannot reach at all: `OAuthVerifierRegistry` registers the
  dev verifier only under dev/test, so the honest pair is a 422 naming the provider and listing what *is* wired
  (§50's class), plus `DevOauthRefusalTest` turning the profile on to produce the 401. §42's finding from the
  other direction: a refusal gated on configuration the shared harness always supplies has never been seen.
- `not_implemented`, the internal conversation door with `NEXUS_AI_INTERNAL_TOKEN` blank — blank being the honest
  way in, since the guard treats "shorter than 16 characters" as unconfigured and a short token would have taken
  the 401 branch instead. Mutating `configured()` to always true turns the answer into `internal_token_missing`,
  which is the ordering proof: the 501 exists to come first.

The unit also caught a resource the suite had been quietly spending. Adding two more property-overriding classes
pushed the run past the container's connection limit and seven tests errored with
`remaining connection slots are reserved for roles with the SUPERUSER attribute` — every distinct
`@SpringBootTest` property set is its own cached context, each holding its own Hikari pool at the base file's
`maximum-pool-size: 20`, so contexts are bought with connections and the container only has so many. Fixed in the
harness (`maximum-pool-size=5`), not by resizing shared infrastructure: the full suite is 192 run, one red, and
that red is `com.nexus.admin`'s, unchanged and not this lane's. A suite that grows by adding contexts has a
connection budget to go with them, and nothing said so until it failed.

```
new witnesses     ConversationApiTest +1 · ModerationFlowTest +1 · NotificationApiTest +1 assertion ·
                  AuthRefusalCodesTest +1 · InternalDoorUnconfiguredTest · DevOauthRefusalTest (both new classes)
harness           NexusIntegrationTest now pins hikari.maximum-pool-size=5, with the reason in its comment
mutations run     4 · each turned a named code back into a generic one; the configured() mutation shows 501 > 401
codes unnamed     9 → 3 in this lane, each with the reason it is unreachable; 13 others are other streams'
suite             187 → 192 run · 1 red, com.nexus.admin's, pre-existing
```

Contract text is unchanged: these codes were always §1-conformant, what was missing was a request. One process
note for the record — the first version of this section's decision entry landed mid-file, leaving
`docs/DECISIONS.md` ordered D51, D55, D52, because the anchor I inserted on sat inside a section that was not the
last. No gate catches that; `grep -n '^## D5'` does.

## 52. Counting the budget D56 said was not gone (2026-09-24)

§51's last line admitted the connection ceiling was only further away, with nothing measuring it. There is now
something measuring it. `TestConnectionBudgetTest` asks the container for its limit
(`current_setting('max_connections')` → **100**), counts the test classes that take a context of their own —
anything carrying `@TestPropertySource`, `@ActiveProfiles`, `@MockitoBean` or `@MockBean`, **eight** today — reads
the pool the running service actually bound (**5**, the D56 pin) from the live `Environment`, and asserts the
arithmetic: no context may hold more than `(100 − 1) / 8 = 12`, and the suite currently sits at 40 of 100. The
gate adds no context itself — it overrides nothing, so it joins the shared one, which is the etiquette the whole
measurement is about.

Two choices worth the reason. The ceiling is *read*, not written down, because it belongs to a container other
streams can resize and a remembered number ages into a wrong constant (D46's deadline column, in prose form); the
pool is read from the environment rather than trusted from the harness, so the file that sets it and the test that
checks it cannot drift apart unnoticed (D44, roles reversed). The assertions are ordered on purpose: the derived
allowance comes first so a raised pool fails for the reason that matters, and the pin comes second so a pin
changed in only one place still fails. Both have their own witness — pool 13 → "no context may hold more than
12" (red), pool 4 → the tie is red while the budget is satisfied.

Softness, stated rather than buried: the count is an upper bound on *distinct* context keys, since two classes
overriding identical properties share one — it over-counts before it under-counts, which is the safe direction for
a ceiling; a `@SpringBootTest` class that didn't extend the harness would be missed (none today, and the failure
message prints the list, so a miss is at least visible); and a class that *drops* its property overrides lowers the
count by merging into the shared context, which is a real saving, not a failure to hide. The number exists to make
the cost of a new witness class visible at the moment it is added — D50 through D56 added six such classes, each
because a promise had no proof — and not to forbid them. The way it was paid for before was seven errors in
somebody else's run.

```
TestConnectionBudgetTest   new · 1 test · ceiling from the container, pool from the Environment, classes from source
measured                   contexts 8 · max_connections 100 · pool 5 · allowance 12 each · worst case 40 of 100
mutations run              2 · pool 13 → allowance red · pool 4 → pin red with the budget satisfied
suite                      192 → 193 run · the 1 red stays com.nexus.admin's AdminConsoleApiTest:289
```

What this does not do. It does not raise or reserve anything on the container — that is shared infrastructure other
streams use, and resizing it is a decision for whoever owns it. It does not gate the *e2e* boot, which opens its
own short-lived platform and has its own datasource. And it does not retire the standing reports; the two
decisions still parked (§45's §8 writes, and §48's §42 text that no client can reach yet) are unchanged.

## 53. A favourite is a link, and the seed ships the links (2026-09-24)

D50 fixed the write door; the demo data predates it. All 18 seeded favourites were checked against what the
readers actually show: 12 published merchants, 4 active offerings, 2 collections that clear §8's publish-and-
attribute gate — clean today, which is exactly why it went into `data/seed/quality.sql` instead of staying a nice
observation: the generator gets edited more often than this file gets read.

Two checks added. `favourites point at a renderable row` re-derives each target through the readers' own
predicates — merchant published, offering active, collection published *and* attributable — and requires
`count(favorites) > 0`, because a check over an empty table is a pass that means nothing (D44's non-zero guard).
`favourite subject_type is one the API can save` is the quieter half: a seeded type outside `FavoriteBody`'s
pattern would load cleanly and then be re-creatable through no door, which is D49's shape arriving through the
seed rather than the filter. `scripts/db_gate_fresh.sh`: 168 → 170 checks, PASS on a from-scratch schema and a
freshly generated dataset.

Both were then made to fail on purpose rather than assumed good: a favourite aimed at a merchant that does not
exist (the predicate reported 7 bad rows) and a `subject_type='voucher'` row (1 bad), inside a transaction that
was rolled back — with a residue query confirming the shared `nexus_test` kept neither.

Standing reports unchanged — §45's §8 writes, §48's unreachable §42 text — plus one more for whoever owns
`infra/db/migrations`: `favorites.subject_type` carries no CHECK and no FK, which is why the vocabulary needs a
seed gate rather than a constraint, and adding the constraint is a migration decision, not this unit's to make.

## 54. The command only the automated caller could run (2026-09-24)

`scripts/run_platform_dev.sh` is `set -euo pipefail`, and its `--log` branch expanded `$ROOT` where the script
defines `root` — so the command its own usage comment tells a person to type died with `ROOT: unbound variable`
before starting anything. Present in `HEAD` as it stands, not damage from §49's rewrite of the block above it. It
went unseen for as long as it has existed because the only scripted caller, `e2e_fresh.sh`, exports
`NEXUS_DEV_LOG` and `NEXUS_DEV_PID`, so the `$ROOT` half of the default was never evaluated in a run anyone
automated. The bug lived exactly in the path the gate takes for granted: the human's.

Fixed to `$root`, and `scripts/check_launcher_log_mode.sh` is the witness: it runs the real script with `mvn`
stubbed and both overrides *absent* — the human path — and asserts it reports a background start instead of a
shell error. Proven both directions: reintroduce `$ROOT` and it fails quoting the line and the message; leave
the fix and it passes. It is now step 0 of `e2e_fresh.sh`, the gate that depends on that launcher and the file
that always set those variables — the automated caller checking the manual path. Not added to CI:
`.github/workflows/ci.yml` is dirty with another stream's work, so that wiring is theirs.

With the path fixed, the live demo was read the way §18's task wants: :8090 against the seeded `nexus` database
(520 merchants, 11,000 reviews, 18 favourites, 4 collections, 60 tables). Directory cards with Chinese titles;
`/api/v1/collections` and `/api/v1/guides/sha-tin-date-night` → 200; `/.well-known/ucp` → the honest
`not_integrated` payload with empty capabilities; a seeded merchant's `/ucp.json` → 404
`ucp_profile_not_published`, which is §47's "no publisher exists" observed on the running service rather than in
a test; the demo consumer's seeded favourites → through the door §45 and §46 hardened; `/me/saved-searches` →
`[]`. The instance was then stopped and :8090 returned to not listening, the state before the check. That is the
read slice of task #9 over HTTP on real data — not its browser leg, which still waits on `apps/web`.

One host fact worth recording because it cost a wasted query: this machine has **two** Postgres containers, and
both have a database called `nexus`. The seeded demo data lives in `nexus-platform-testpg` (host 5433), which is
what `.env`'s `NEXUS_DB_HOST`/`NEXUS_PG_HOST_PORT` and the launcher's banner point at. `nexus-postgres`
(55433→5432) has an unrelated `nexus` with none of these tables — querying it for `favorites` returns "relation
does not exist", which reads like a broken seed and is not one. Nothing here reconciles them; pointing a verifier
at the wrong one is the failure to avoid.

```
launcher              $ROOT → $root at run_platform_dev.sh:86-87; smoke red with the bug, green without
e2e                   gains step 0/10 (the launcher smoke); rung, walks and ledger unchanged from §51
live check            :8090 read slice above, then stopped; :8090 is not listening again
```

Standing reports unchanged, plus this one: whoever owns CI should run `scripts/check_launcher_log_mode.sh` there
too, and the two-`nexus` ambiguity on this host is a decision for whoever owns `infra/`, not something this unit
quietly merges.

## 55. The consumer slice, walked in a browser this time (2026-09-24)

Task #9's read half is now evidence rather than intent. With the platform on :8090 (dev profile, seeded
`nexus` database) and `apps/web` built and served on :3000 — both started for this check and stopped
afterwards, nothing in `apps/web` edited, its own `typecheck` and `next build` run as they stood with the
other stream's work in the tree — a real browser was pointed at the two consumer surfaces:

- `/` → 325 KB of server-rendered HTML; the a11y tree shows the seeded merchants with `示例数据` badges on
  every card, `商户自报 · 高置信 · 更新于 今天` provenance lines, `未验证` and `可能已过期` states where the data
  says so, distances and walk times, `营业中`/`休息中` computed open-state, and the four ranking rails each
  naming their own ordering ("按评价数量而非人为推荐", "以已验证的均价排序"). No console messages.
- `/m/bauhinia-cafe` → title `洋紫荊咖啡 — 咖啡 · 中環 · Central · NEXUS`, h1, `4.7 (331 条评价)`, `HK$78 每人`,
  provenance + confidence + freshness, open status, demo declaration. No console messages.

That closes the part of #9 that kept being assumed: the seed→platform→web chain renders, the trust
affordances of §19/§20/§109 survive the trip into a browser, and organic ranking text is separated from
paid placement in the copy the page actually shows. What #9 still lacks is the automated half — a Playwright
suite over these flows (the app has no test-runner wired for it), and the same walk through the merchant
console and admin screens, which are another stream's in-flight files. So #9 stays open, with the read slice
now demonstrated instead of argued.

One process note, because a wide filter is a real risk and this one was too wide: stopping the two servers
used a command-line match that also named `next-server`, which any other project's dev server would share.
It killed 18 PIDs; afterwards the other servers on this machine were checked and are alive (vite on 5199, the
football-os previews, `next dev` on 3100, the containers on 5433/55433/6380/16380/19000), so no collateral
damage is visible — but the lesson is to stop what you started by the PIDs you recorded, not by pattern.

## 56. The seam between "public reads work" and "my list works" (2026-09-24)

525 public-read checks run against the seeded throwaway database; the Java suite checks the signed-in doors
against tenants it creates itself. Nobody joined them. The question that falls in the gap is the one a user
meets: does the **seeded account's own saved list** survive seed → API? D58 asserted that data in
`quality.sql`; §56's sibling now asserts the door, in `scripts/verify_seed_surface.py`, run from
`e2e_fresh.sh` step 7 where the database belongs to the run.

It checks that the favourites door is 401 without a token; that the demo login reaches
`demo.consumer@example.hk` — measured first, because that one account owns all 18 seeded favourites and a
green check against an empty inbox would have proved nothing; that the list returns 18 rows with types, uuids
and dates, 15 carrying their seeded note text; that the two saved collections resolve through the public list
to slugs that open at 200, and four saved merchants open on their public pages; and that saved-searches answers
`[]`, because the seed stores none. Saved offerings are typed and counted but not dereferenced — an offering
has no public by-id page, only a route through its merchant, which the favourites row does not carry; that
missing page is reported, same as §8's other gaps. The check refuses an empty list and the step dies on a
non-zero exit, and its failure path was exercised in the same session (pointed at an unknown tenant: two
failures, rc=1), which is what makes the passes mean something.

```
verify_seed_surface.py   15 checks · part of e2e step 7 · positive on :8090 and negative on a bad tenant
e2e                      PASS end to end: 525 reads, three walks, 15 signed-in checks, rung, ledger unchanged
```

Standing reports unchanged.

## 57. §8's write opens, and stops short of the publish button (2026-09-25)

`POST /api/v1/collections` has been in the contract since the contract was written and unserved since then,
because the decision behind it — who owns a *published* guide — is not this lane's to make: `collections` carries
`tenant_id` and `author_id` and no merchant column, so the workspace permission chain cannot guard it either. D61
separates the two halves of that sentence. A draft settles nothing, because §8 serves a row only when
`visibility='public'`, `published_at` is set, and the row is attributable. So the door is open now:
`@RequiresAuth`, one row per accepted call, `author_id` read off the session while the other five trust-bearing
columns are literals in the `INSERT`, six reserved body keys refused by name with the reason, and a retried slug
answered `409 slug_taken` from V1's `collections_tenant_id_slug_key` — naming the row it hit and whether that row
is the caller's own. No verb in this build stamps `published_at`, and the test asks the running router whether that
is still true rather than reading this file.

Nine ways to break a promise were applied to the real source and reverted, one at a time: each half of the
publishability AND, both `INSERT` literals, the reserved-key refusal, the auth annotation, the cover-scheme check,
the 409's ownership field, and a publish verb sneaking in as a second mapping annotation. Three of the nine had to
be earned. Two came back **green** on the first pass — the class had walked only one corner of an AND, and it had
only ever clashed with its own row. The auth one then came back green a *second* time after being "fixed", because
the fix was `assertThat(…isAnnotationPresent(RequiresAuth…)).as("…")` with no terminal assertion at the end of the
chain: an assertion object, discarded. That shape is a class of bug rather than a typo, so all 40 platform test
files were swept for it (zero, with the sweeper falsified on a planted file first). The run that matters is the one
after the repair.

```
new                 CollectionsWriteController · CollectionsRepository +3 · CollectionDraftWriteTest (6 methods)
suite               212 run · 7 failing, all of them `CommerceApiTest` (another stream's untracked package —
                    reported, not touched) · this unit's 6 green
e2e                 blocked tree-wide at step 4/10 by another stream's untracked `V7__share_links.sql`: the
                    loader's checked-in `out/00_truncate.sql` names 22 tables, `share_links` FKs into one of
                    them, so `load.sh` dies on "cannot truncate a table referenced in a foreign key constraint".
                    Steps 0–3 green. §8's served set is therefore witnessed by the suite's own router read,
                    not by this gate. D62 is that gap.
```

```
mutations           9 applied, 9 red on the pass that followed the repairs (D61 §3 names both greens: an AND
                    missing a corner, and a chain that never reached a terminal assertion)
swept               all 40 src/test/java files for that chain shape: one case, the M7 one; the sweeper was
                    falsified on a planted file before its zero was quoted
```

Standing reports unchanged, plus one new: `collections` is one of six tables with an `updated_at` column and **no**
`*_updated_at` trigger (`business_hours`, `availability_slots`, `reviews`, `collections`, `user_preferences`,
`review_summaries`). The two writers that exist today set the column by hand in their `UPDATE`, so nothing renders
a stale timestamp now; what guards the writer that forgets is nothing. A migration is shared state, so this is
reported rather than taken.

## 58. A green gate that asserted nothing, found by reading the line (2026-09-25)

`assertThat(x)` returns an object, `.as("…")` returns the same object with a better message attached, and only
calls like `isTrue()` / `isEqualTo()` / `hasSize()` decide anything. D61's own repair for mutation M7 was written in
precisely that broken shape — a describer-terminated chain inside a stream `peek` — so it sat green through two
mutation runs. The general finding is not about that route: **a statement that decides nothing is
indistinguishable, on every possible source, from the gate it replaced.** Memory cannot hold that open, so a gate
does: `AssertionChainShapeTest` walks `src/test/java` off disk (41 files, 1,505 `assertThat*(` entry points read,
0 chains that stop at a describer, other streams' untracked packages included) and reports the file and line of
anything it flags.

Because an empty finding list is exactly what a clean tree and a blind reader both print, the gate is not allowed
to testify on its own emptiness: it asserts its own census (over 1,000 entry points actually read, floor at two
thirds of the tree) and it checks its reader against ten planted fixtures — four shapes that must be flagged, six
that must not — before anything it says about the tree counts.

```
new                 AssertionChainShapeTest (2 methods; plain JUnit, so no context and no pool against D56's ceiling)
mutations           4 run, all red, each reverted from a byte-for-byte backup and re-verified green:
                      plant a describer-only chain in a real test   RED — CollectionDraftWriteTest.java:182, chain=[as]
                      blind the reader to `assertThat(`              RED x2 — census reads `Expecting actual: 8` (1,505 entry points are 8 without it), then the planted cases
                      mask() erases instead of blanking bodies       RED x2 — same two guards
                      declare `isEqualTo` a describer                RED x2 — 361 real chains named
suite               Tests run: 214, Failures: 7 — all seven com.nexus.commerce.CommerceApiTest (untracked, another
                      stream, the same seven D61 reported); the new gate ran green inside that run
next                task #38: the seed loader's truncate list vs. the migration set — fresh-DB gates are red tree-wide
```


## 59. A truncate that only ever succeeded, and the two branches that had to be planted (2026-09-25)

`out/00_truncate.sql` was a list of 22 table names maintained by hand, and V7 arrived with a foreign key from
`share_links` to `users`. Postgres refuses to truncate a parent while any key points at it — empty or not — so every
fresh-database gate died on that line, on a table holding zero rows, blocking a reset that would have destroyed
nothing. Neither obvious answer survives scrutiny: adding V7's table to the list makes the next migration reproduce
the death, and `TRUNCATE … CASCADE` buys a permanent green by deleting the line between "demo data" and "rows the
platform wrote" (§109/§110). The rule that replaced them decides at load time — anchor = the tables the generator
owns, closure = every table the live `pg_constraint` hangs off them, permission outside the anchor = **emptiness** —
and a non-empty stranger stops the load by name and row count instead of being emptied behind somebody's back
(`docs/DECISIONS.md` D63).

The new part is `scripts/seed_truncate_probe.sh`, because a script whose only observable outcome is success proves
neither half of that claim. It builds its own throwaway database, loads the real seed, plants two children of
`merchants` — one empty, one holding a row — and puts the same file `load.sh` puts to work: the row-holder must
refuse, name itself, quote the way out, and leave the dataset untouched; then, with the row deleted, the same script
must clear both strangers.

```
new                 scripts/seed_truncate_probe.sh (4 steps, its own database, dropped on exit)
changed             data/seed/generate.py emit_truncate(): FK closure, emptiness as the only permission outside
                      the anchor, refusal by name+count, operator hint, "no tables exist yet" guard, NOTICE that
                      prints the named/found split. load.sh's usage text was the only thing edited there (27
                      dependents, not 28; and what happens without the flag). db_gate_fresh.sh is now 6/6.
measured            plain anchor 22 named -> closure 47: 25 strangers, 24 of them DEPENDENT_TABLES + share_links
                    wide anchor 49 named -> closure 50: 1 stranger, share_links
                    events/agent_runs/llm_calls hang off `tenants`, which plain mode excludes on purpose, so only
                    the wide anchor reaches them — and a fresh database needs no flag at all now
mutations           2 run, both red at step 3, each reverted by md5 and re-verified green:
                      M1' refusal neutralised  RED — "the truncate SUCCEEDED with rows in probe_row_child — it
                        cleared a table nobody listed", beside "49 table(s) cleared -- 22 named, 27 found"
                      M2' closure arm dead     RED — `cannot truncate a table referenced in a foreign key
                        constraint / Table "reservations" references "availability_slots"`, i.e. the 22-name list
                        cannot truncate even its own tables; the flag was never about strangers
gates               db_gate_fresh.sh: RESULT: PASS — 172 quality checks on a from-scratch schema (tables=58,
                      migrations=7), plus the truncate shown clearing an empty stranger and refusing a full one
                    e2e_fresh.sh: RESULT: PASS — 526 served reads, the reservation/review/workspace walks, the
                      100-request rung, the contract ledger
reported            `audit_logs` is named by neither list and reached by neither anchor (it points at `tenants`),
                      so verification-run rows there outlive a reseed in both modes — plausibly right for an audit
                      trail, so it is reported rather than quietly added. 11 columns are named as references and
                      carry no constraint (polymorphic subject_id, actor/user ids): invisible to any closure.
                      `nexus_test` now refuses a plain reload by design — public.share_links holds 20 rows there.
next                task #39: quality.sql keeps its own hand list of dependent tables — its "no seeded
                      orders/reservations" check counts 4 of the 27, while the truncate now knows 47. Either the
                      gate learns the same closure or the difference gets a reason written next to it.
```

## 60. A gate that reads the schema in one half and remembers it in the other (2026-09-25)

`quality.sql` discovers every foreign key in the demo graph from `pg_constraint`, so a migration nobody has read
is checked the day it lands — and then asserted "no fabricated traffic" over **four tables named by hand**. The
two halves of one file disagreed about what the schema is. Measured before writing anything, three places held
their own copy of the answer, and part B's was a name short of part A's. The check is now the same closure
D63's loader uses: every table the catalogue hangs off the seed's own tables is counted at run time, and two rows
come out of it — a census that has to say how many tables it opened (measured 29 of 52, floor at two thirds) and
the claim itself, which is only allowed to pass when `swept > 0`, because a sweep that reached nothing must not be
able to report a clean database.

```
new/changed       data/seed/quality.sql — one seed_anchor list feeding parts A and B, the catalogue traffic
                    sweep and its census row; the four-name "no seeded orders/reservations" row is gone
                  data/seed/generate.py — two comments that pointed at the removed check name
                    (comment-only: the regenerated out/00_truncate.sql is md5-identical to the committed one)
measured          three copies of the anchor existed: part A 23 == generate.py's DEMO_TABLES, part B's sweep 22,
                    missing `moderation_cases` — which costs nothing today, because nothing in V1–V7 references
                    that table (91 `fk:` rows before the change and after). Silent drift until the day it isn't.
mutations         4 verdicts, run against the gate's own freshly loaded database (--keep):
                    (a) clean                          173 PASS / 0 FAIL
                    (b) closure arm blinded            RED 2 — census "0 of 23 … were counted", claim "the
                        closure reaches nothing outside the anchor … not a clean bill of health"
                    (c) one row planted in share_links RED 1 — "written elsewhere: share_links (1 row(s))",
                        census still green at 29; the four-name row this replaces would have printed PASS
                    (d) that row deleted               173 PASS again (every revert md5-verified)
gates             db_gate_fresh.sh: RESULT: PASS — 173 quality checks on a from-scratch schema (tables=58,
                    migrations=7), plus the truncate probe as step 6/6; exit 0. Check total 172 → 173
                    (−1 hand row, +2 catalogue rows).
reported          the long-lived `nexus` database is no longer the seeded dataset: the new row reads
                    agent_runs (40), audit_logs (53), events (35), referrals (1), reservations (6) there and
                    seven other checks are red for the same kind of reason (1,727 reviewed subjects with no
                    rating fact, an empty moderation queue, 171 undeclared fact sources). STATUS's "all 150
                    checks passed" line for `nexus` was measured 2026-09-22 against a database that has been
                    used since. Repairing it means RESEED_DEPENDENTS=1 on a shared demo database, which would
                    delete another stream's walk evidence — reported, not executed. The file's header now says
                    what it gates and what it is when pointed somewhere else.
next              task #40: eleven columns are named as references and carry no constraint (polymorphic
                    subject_id, actor/user/merchant ids). Neither the loader's closure nor this sweep can see
                    them — measure which of them the seed actually writes, and whether a probe like the
                    favorites/permission_grants ones already covers each one.
```


## 61. A check that resolves a type, and the remainder that turned out to be twenty-five columns (2026-09-25)

`quality.sql` has always asked whether a `facts` row points at a merchant or an offering — by `JOIN merchants`,
`JOIN offerings`. Both joins are sound for the type they name and both have the same hole in the middle: a fact
whose `subject_type` is a type nobody joins is invisible to every one of them at once. `favorites` and
`permission_grants` already had the shape that cannot miss — build a `(type, key)` set out of the tables each type
names, group by the declared type, and let an unknown type be an orphan by definition. `facts` did not. Measured,
the hole had an occupant the file had never counted: **684** location facts.

§60's `next` pointer said "eleven columns name a reference and carry no constraint". That was a hand count of the
ones I had looked at — the same mistake D64 caught in the traffic check. Counted from the catalogue instead
(`pg_attribute`: every `public` `*_id` column with no foreign key that is not its own table's single-column PK or
UNIQUE) the schema has **25**, and the seeded dataset writes **five** of them. Two of the five were already
probed, one is now, one is a column that is not a reference at all, and one is this hole one level down.

```
new/changed       data/seed/quality.sql — an orphan probe for facts over merchant|offering|location|review,
                    grouped by the declared type so an unprobed type produces its own row.
                  docs/DECISIONS.md D65 — why `policy` is deliberately left out of the probe set rather than
                    JOINed to something it does not point at.
measured          25 unconstrained `*_id` columns; the seed writes 5 — facts.subject_id 5,688 /
                    moderation_cases.subject_id 544 / permission_grants.subject_id 36 / favorites.subject_id 18 /
                    user_identities.provider_id 5. The other 20 live in tables D64's sweep refuses to seed over.
                  facts by type: merchant 2,080 + offering 2,924 + location 684 = the whole table.
                  user_identities.provider_id is not a reference — V1:53 calls it "subject / opaque id (never a
                    token)", an external string; a JOIN would be the wrong check, so the naming predicate's 25
                    contains at least one column with nothing to resolve.
mutations         4 verdicts on the gate's own freshly loaded database (--keep):
                    (a) clean                        176 PASS / 0 FAIL, exit 0
                    (b) plant a merchant fact with a random id   RED `orphan: facts.merchant — 1 unresolvable
                        of 2081 fact(s)`; location/offering print 0 on the same run
                    (c) plant a fact with the invented type `policy`  RED `orphan: facts.policy — 1 unresolvable
                        of 1 fact(s)` — the fifth name in V1's comment has no table to point at, and says so
                    (d) delete both                   176 PASS again, facts back to 5,688
                    The first fixture was illegal in two other dimensions (non-demo:// source, no expires_at) and
                    so came back with three reds, which proved nothing about the arm under test. Re-planted with
                    legal provenance and a TTL: exactly `2 check(s) failed`, both orphan rows. Side witness kept
                    anyway — `facts all carry expires_at` caught the sloppy fixture on its own account.
gates             db_gate_fresh.sh: RESULT: PASS — 176 quality checks on a from-scratch schema (tables=58,
                    migrations=7), plus the truncate probe as step 6/6; exit 0. Check total 173 → 176.
                  Kept database dropped after the cleanup run; the shared `nexus` demo database was read, never
                    written — it holds 3,961 facts and 0 moderation cases against the gate's 5,688 and 544, the
                    same drift D64 §5 records, now from a second table.
next              task #41 (D66): make the file name its own blind spots. The 25-column census above was written
                    by a throwaway python script against `pg_attribute`; it belongs in `quality.sql` as a derived
                    list LEFT JOINed against a registry of the (table, column) pairs the probes actually resolve,
                    so a new unconstrained `*_id` column the seed starts writing shows up as a named row instead
                    of as silence — and a census row that has to say how many columns it opened, D64's floor of
                    two-thirds applying. `moderation_cases.subject_id` is the one already-known case: V1:574
                    declares five types, the generator emits `review`, and the queue check `JOIN reviews`, so the
                    other four would be invisible exactly the way `location` was.


## 62. The file that counted its own blind spots (2026-09-25)

D65 measured its remainder with a throwaway script in a temp directory, which makes the measurement a fact about
one afternoon. It moved into `quality.sql`: a `pg_attribute` pass enumerates every `public` `*_id` column that
carries no foreign key and is not its own table's single-column PK or UNIQUE, counts the rows and the non-empty
values in each, and joins that against a five-entry registry saying *why* each answered column is answered —
`probe`, `join-one-type`, or `not-a-reference`. The catalogue decides who has to answer; the hand list only
supplies answers, which is the direction that makes a new column go red instead of quiet.

```
new/changed       data/seed/quality.sql — ref_cat census + ref_registry + four rows (census reach, every seeded
                    column probed-or-explained, no stale registry entry, and the waiver-scope row).
measured          25 unconstrained *_id columns; the seed writes 5 of them (facts 5,688 / moderation_cases 544 /
                    permission_grants 36 / favorites 18 / user_identities.provider_id 5). Registry holds
                    3 probe + 1 join-one-type + 1 not-a-reference; `user_identities.provider_id` is a *false
                    positive of the naming heuristic* — V1:53: an opaque external id no table could resolve.
                  The waiver row re-reads its own assumption every run: `moderation_cases.subject_id ships
                    1 subject_type(s)` while the generator emits one of V1:574's five.
mutations         3 plants + 1 blinded predicate, on the gate's own loaded database (--keep):
                    (a) clean                              180 PASS / 0 FAIL, exit 0 (was 176)
                    (b) census predicate blinded            RED ×3 — 0 measured, "0 of 0 carry values … this row
                        cannot pass on an empty census", 5 stale of 5
                    (c) probe_d66(thing_id) with one row    RED — names probe_d66.thing_id (1 row(s)) and nothing else
                    (d) a merchant-typed moderation case    RED — the waiver row alone: "ships 2 subject_type(s)",
                        while every review-joining check stays green over the new case (that is the hole)
                    (e) revert all                           180 PASS; mutated file restored md5-identical
gates             db_gate_fresh.sh: -> 180 quality checks passed against a from-scratch schema (tables=58,
                    migrations=7); RESULT: PASS with the truncate probe as step 6/6. Check total 176 → 180.
reported          the favourites probe and the favourites vocabulary row disagree in both directions: the probe
                    builds a `user` arm no API body can carry, and has no `guide` arm for a type the door accepts
                    (a guide is a collections row with kind='guide', so its id resolves while its type string
                    would print an orphan that is not one). Choosing the authoritative vocabulary is a contract
                    decision — task #42, not a check edit. The registry's `why` strings are written but not
                    printed (kind counts are), acceptable at five entries and not at fifty.
next              task #42 (D67): settle the two vocabularies for `favorites`, then give `moderation_cases` a real
                    (type,key) probe over review|merchant|document|message|listing so the join-one-type waiver can
                    be retired instead of merely watched — the census row should print 4 probe / 0 join-one-type
                    when that lands.


## 63. A seeded row the write path refuses to re-create (2026-09-25)

D66 registered the favourites probe as `probe` while its own `why` text admitted the probe's type set was not the
vocabulary the door accepts — a `user` arm for a type no `FavoriteBody` can carry, no `guide` arm for one it can.
Writing a gap down is not closing it. The arms were rebuilt against `MeController` instead of against the migration
comment, and `guide`/`collection` were pinned to the row's `kind` exactly the way `assertSubjectInTenant` pins them
(`CollectionsRepository.isPublishable` ends in `and c.kind = :kind`).

That pinning is what found the defect: the seed had 18 favourites, and of the two typed `collection`, one pointed
at `sha-tin-date-night`, which is `kind='guide'` — a pair the door answers with `404 subject_not_found`, so the
dataset shipped a row the API could never re-create. The generator was the only party disagreeing:
`build_collections()` returned `dict(id, slug)` with no `kind`, and the favourites loop hard-coded `"collection"`.
Now the kind is threaded through and emitted per row.

```
new/changed       data/seed/quality.sql — the favourites probe's arms are the door's four types, with guide and
                    collection resolved against collections by kind; registry entry rewritten to say what it now is
                  data/seed/generate.py — build_collections() carries `kind`; the favourites loop emits g["kind"]
                    instead of a constant (out/ is a generated artifact and gitignored: data/seed/out is in
                    ./.gitignore:21, so the change ships as generator source, not as SQL)
measured          seeded favourites before: merchant 12 / offering 4 / collection 2 — one of the two on a guide row.
                    after: merchant 12 / offering 4 / collection 1 / guide 1, each matching its row's kind.
                  collections is guide 1, collection 2, itinerary 1 — and `itinerary` is in neither FavoriteBody's
                    pattern nor V1:619's comment, so that row is unshareable through /me/favorites by construction.
                    Reported, not fixed: deciding it should be saveable is a contract change.
mutations         4 verdicts on the gate's own loaded database (--keep):
                    (a) clean                       181 PASS / 0 FAIL, exit 0 (180 → 181: the probe prints a row
                        per type *present*, and a fourth type is present now that guide resolves on its own)
                    (b) yesterday's label restored  RED — `orphan: favorites.collection — 1 unresolvable of 2
                        row(s)`, and nothing else. The pre-fix dataset is the fixture
                    (c) an invented `itinerary`     RED ×2 — the orphan row (no arm knows the type) and the
                        vocabulary row (the door refuses it), from one planted label
                    (d) labels re-derived from kind 181 PASS again
gates             db_gate_fresh.sh: -> 181 quality checks against a from-scratch schema (tables=58, migrations=7).
                    e2e_fresh.sh not re-run, with the reason measured: it names favourites nowhere
                    (grep -rn "favorite|favourite" scripts/e2e_fresh.sh -> no output) and listFavorites has no
                    subject_type branch, so no served read depends on the label that changed.
next              task #42's second half (D68): `moderation_cases` still carries the only remaining join-one-type
                    waiver. Give it a real (type,key) probe over V1:574's five declared types so D66's
                    waiver-scope row becomes a probe row — the registry line should print `probe 4` and no
                    `join-one-type` when that lands.
## 64. The waiver that was only a thermometer (2026-09-25)

D66 registered `moderation_cases.subject_id` as a `join-one-type` waiver and added a row that re-reads the
waiver's own assumption each run. D67 had just shown that a gap written down stays open, so the assumption got
answered instead of watched: a `(type,key)` probe over four of V1:574's five declared types, and the waiver
retired. Four of the five types had never been resolved by any check in the file — every queue check reads
`JOIN reviews`, and the generator emits 544 review cases.

```
new/changed       data/seed/quality.sql — orphan probe for moderation_cases over review, merchant, document,
                    message; the registry entry becomes `probe`, so `join-one-type` now has zero entries.
                  `listing` is left out on purpose: no table in this schema is a listing (the D65 `policy` habit),
                    and adding an arm would mean inventing that `listing` means `offering`.
measured          seeded queue: 544 cases, all `subject_type='review'`; four declared types with no rows, one
                    declared type with no table. An empty queue contributes no probe rows — that state is refused
                    by name by the existing `the queue has something in it` row, red on `nexus` again.
                  registry census: `0 stale of 5 registered (not-a-reference 1, probe 4)`, and the waiver-scope
                    row reporting `no waiver of that kind is registered` — it guards an empty set and says so.
mutations         A: one `merchant` case with `subject_id = gen_random_uuid()` — red, 1 unresolvable of 1.
                  B: one `listing` case — red as an orphan by construction, the type has no arm.
                  with both: ERROR quality gate: 2 check(s) failed, and the RAISE names both.
                  C (control, the load-bearing one): one case on a real `merchants.id`, one on a real
                    `documents.id` — green, and 184 rows checked instead of 182, so the probe resolves
                    positives and reports per type rather than always failing.
                  plants removed: 182.
gates             db_gate_fresh.sh: RESULT: PASS — 182 quality checks on a from-scratch schema (tables=58,
                    migrations=7), plus the seed truncate shown clearing an empty stranger and refusing one
                    that holds rows. SYNTHETIC DEMO DATA. The live databases were not opened by this run.
                  Kept gate database used for the plants, dropped after the restore.
next              the registry has no `join-one-type` entry left, so D66's waiver-scope row now guards an empty
                    set — it still has to say so truthfully (`no waiver of that kind is registered`) rather than
                    disappear. Remaining work in this lane: the served `/api/v1/me` surface still reads
                    `saved_searches.notify` nowhere (open report). And the `updated_at` standing report (six
                    tables without a `*_updated_at` trigger) is now resolved enough to stop being a number:
                    measured against the fresh schema, 21 tables carry the column and 15 have a trigger; of the
                    other six, three are written by exactly one hand-written statement each that does set
                    `updated_at = now()` (`reviews` at ModerationRepository.java:91, `availability_slots` at
                    ReservationRepository.java:48 and :196, `user_preferences` at
                    IdentityRepository.java:252), and three (`business_hours`, `collections`,
                    `review_summaries`) have no UPDATE anywhere under `services/platform/src/main`. So nothing
                    is currently stale — what is missing is a witness for the day someone adds a second writer
                    and forgets the literal. That witness cannot live in quality.sql, which reads the seed and
                    never sees an application UPDATE, so this stays a report rather than becoming a gate here.
## 65. Twelve pairs, four probes, one CHECK (2026-09-25)

The schema holds 12 `(type, key)` polymorphic pairs; `quality.sql` resolved 4 of them and had never asked how
many there were. D64/D65/D66/D68 each closed one instance of "a check reads a hand list where the schema could
be asked"; this one asks the schema the pair question by shape — a table holding both `stem_type` and `stem_id` —
so `mime_type` and `content_type` drop out with no exception list, and a pair added tomorrow is counted tomorrow.
Measuring the second half of the question produced the finding: **11 of the 12 type columns are bounded by no
constraint at all.** V1 writes those vocabularies as column comments. Only `share_links.subject_type` (V7) has a
CHECK. It is not true that nothing else bounds them — `EventsController:63`, `PermissionService:40`,
`MeController.FavoriteBody:59`, `CollectionsWriteController:325` and `ModerationController:130` each hold their
own list, and D69 §2 says so because the first draft of that section over-claimed in exactly the direction a
reader would repeat.

```
new/changed       data/seed/quality.sql — poly_cat (pairs + rows + distinct types + whether a CHECK bounds the
                    type column, all from pg_attribute/pg_constraint), poly_probed (the 4 pairs this file
                    resolves), and three rows: the census, a stale-pair check, and
                    `a seeded polymorphic vocabulary is bounded or probed`.
                  D68's section and its SQL comment corrected in place: both said V1:574 `declares` the five
                    queue types behind a CHECK. It does not; the plants were legal because nothing touches the
                    column — a stronger reason than the one written, and the same class of error D50 caught
                    (a doc sentence about a guard the schema cannot express).
measured          fresh gate DB: 12 pairs; 4 carry seeded rows (facts 5,688 / favorites 18 / moderation_cases 544
                    / permission_grants 36 — the loader's own headers); those 4 are the 4 probed, so the new row
                    is green by equality, and says so. Drifted `nexus` DB: the same row red, naming 5
                    application-written pairs (audit_logs x2, events x2, referrals) — including
                    `events.subject_type (35 row(s), 0 type(s))`, because that column is nullable (V1:769) and
                    NULL on all 35 rows: a pair can carry rows and hold no type at all.
mutations         P1: one `referrals` row, referrer_id a real users.id (so not an orphan) — red, naming
                    referrals.referrer_type; two older censuses (D66's columns, D64's traffic) agreed on the
                    same row. P2: `create table d69_planted_pair (id, thing_type, thing_id)` + one row, with no
                    list edited anywhere — the census printed 13 and stayed PASS on its own floor row while the
                    bounded-or-probed row named the new pair. Restore: 185 green, detail
                    `4 of 12 pair(s) carry seeded rows; 1 is bounded by a CHECK; each seeded one is resolved`.
gates             db_gate_fresh.sh: RESULT: PASS — 185 quality checks on a from-scratch schema (tables=58,
                    migrations=7), plus the seed truncate probe. Kept gate database used for both plants,
                    dropped after the restore. The live databases were not opened by this run.
next              two ways to close the 11-unbounded finding and neither is mine to pick: add CHECKs (a contract
                    change to V1's declared vocabulary, and V1 is already applied wherever the demo DB lives) or
                    leave the vocabulary enforced only here. What is missing regardless is a witness for the
                    application-written pairs — quality.sql reads the seed and cannot see `events` or
                    `audit_logs` rows, so the honest home for that is the Java suite (a test that writes an
                    event and asserts its subject_type resolves), not this file. Recorded as a report; also
                    still open: `saved_searches.notify` read by nothing.
## 66. A telemetry door's second half, witnessed (2026-09-25)

`EventsIngestTest` had three tests proving `actor_type` is a server fact and **none** touching the other half of
the same pair rule — `subject_type` / `subject_id`. Walking that half found a live seam: an unauthenticated
`POST /api/v1/events` (anonymous + `session_id`, which §11 allows) may claim any `subject_type` bounded only by
`^[a-z][a-z0-9_]{0,31}$` and any `subject_id` uuid; nothing resolves the key, checks the tenant, or consults a
declared vocabulary. `v_merchant_funnel` (V1:1015) joins on exactly that pair and is what the merchant-facing
overview answers with, so a merchant's displayed `views` count can be moved by an outside caller that names the
merchant id — which the consumer catalogue publishes.

```
new/changed       services/platform/src/test/java/com/nexus/growth/EventsIngestTest.java — three tests: a claimed
                    `merchant` subject is stored as claimed and takes v_merchant_funnel.views 0 -> 1; a type name
                    that resolves to nothing is accepted and stored (with the merchant row count asserted zero to
                    prove the id resolves nowhere); and the pair rule itself, pinned so a future fix reads as a
                    change rather than a regression. No production behaviour changed.
measured          API_CONTRACT.md:516 documents the batch body as {name, properties, occurred_at, session_id} —
                    subject_type/subject_id are read by the controller and named by the contract nowhere.
                    Who consumes the pair, from a grep of `src/main/java` for `from events|join events|
                    v_merchant_funnel|v_north_star`: the merchant-facing side (AnalyticsRepository:41,
                    MerchantOverviewController, MerchantContentController:410, MerchantAnalyticsRepository,
                    CustomerRepository) via the funnel view; admin reports (AdminAiRepository,
                    AdminSearchAnalyticsRepository); and MeController:158, whose export selects on the
                    *actor* (server-computed) and echoes the claimed subject back to its own owner. No ranking or
                    search-scoring query appears in that set, so the contract's §66 promise holds —
                    search *analytics* is a report, not a rank input.
                    Contract coverage, sentence by sentence: "never validates a business invariant" (an
                    unresolved subject is therefore consistent with the design, not a violation of it);
                    "must not be used as a write path for anything a user can see" (the event row is not
                    displayed, but the derived count is — the purpose is breached in spirit, the letter is not);
                    "no free-text field is stored" (subject_type is bounded by the same kind of shape rule as
                    `name`, so calling one free text and the other not would be arbitrary — stated as a question
                    about the clause, not as a defect).
mutations         M1 (subject_type must be one of the declared names) reddened only `undeclaredSubjectTypeIsAccepted` and left
                    the funnel test GREEN: `merchant` is a declared name and the id is a real merchant, so the
                    merchant-visible count still moved on an anonymous caller's claim. Narrowing what a subject
                    may be CALLED does not touch who may claim one or whether it resolves.
                    M2 (drop the client's subject pair) reddened all three, including the pair-rule test — the
                    one guard the door has today, so a test surviving that would have pinned nothing.
                    After both restores: 12/12 green, `git status` clean for the mutated file.
gates             mvn -o test -Dtest=EventsIngestTest: Tests run: 12, Failures: 0 (was 9 before this unit).
                  No gate file changed; quality.sql and the seed are untouched by this unit.
next              the decision, which is not mine to make silently: resolve the key at the door, drop
                    client-claimed subjects for anonymous callers, or document `subject_type`/`subject_id` in the
                    body and label the funnel as unverified telemetry. The M1/M2 split below is the argument for
                    choosing deliberately rather than "adding validation": a declared vocabulary alone leaves the
                    merchant-visible count open. Two open reports unchanged: `saved_searches.notify` read by
                    nothing; the drifted shared `nexus` demo database (11 quality.sql checks red there for drift
                    reasons, including D69's new pair row naming the 5 application-written pairs).

## 67. An arm no door can fill, and a type every key fills (2026-09-25)

`permission_grants.subject_type` has three vocabulary lists and no two agreed. `V1__init.sql:130` names
`user|merchant_user|agent|api_key`; `PermissionService.java:40` holds `HUMAN_SUBJECT_TYPES = user, merchant_user`;
and the file's own orphan probe — unchanged since D31 — resolved `merchant|user|merchant_user`. `merchant` is in
only the probe: no migration comment, no constant, and no call site produces it (`grant()` is type-parameterised
at :133; the subject-typed writers are `MerchantService.java:63` and `MerchantWorkspaceService.java:177` with
`"user"`, and `ApiKeyService.java:67` with `"api_key"`). `api_key` is in the migration *and* in the code that
writes a grant per scope for every key the console creates — and was in no arm.

So the probe was wrong in both directions at once, and the two directions have different costs. A `merchant`
grant keyed to a real merchant resolved GREEN on the HEAD file — and because the probe groups by the types
present, it added a passing check: **185 → 186**, the gate getting more impressive as it is fed fiction. The
missing `api_key` arm would have turned every legitimate key's grants red: `2 unresolvable subject_id of
2 grant(s)`. Nothing in the shipped seed writes api keys, which is the only reason that second one never reached
a run.

```
new/changed       data/seed/quality.sql only, +203/-11 lines, 185 -> 191 checks. The grants probe now carries
                    user | merchant_user | api_key, each joined the way the consuming lookup joins: the person plus
                    an ACTIVE membership (D31 — a grant keyed to a merchant_users row id is unreachable), and live
                    keys only, because ApiKeyService.verify looks a key up with `k.revoked_at is null`. No merchant
                    arm; the absence is argued in the file. D66's registry entry for the column is corrected in
                    place — it claimed "an agent or api_key grant would be an orphan by construction", and half of
                    that was wrong.
                  poly_vocab: 18 rows, one per (table, type) across the four probed pairs, each with kind
                    (arm | no-referent), a referent table, filled (seed | door | declared) and a reason.
                    poly_arms: 15 rows — the same list as data, because a UNION clause is not readable back off
                    SQL. poly_types: which types the loaded data actually carries, through D69's pg_attribute join.
                  Six checks: arms<->vocabulary two-way equality; every armed referent exists (to_regclass); every
                    no-referent waiver's table still absent; every arm claimed seeded still carries rows; no type
                    in the data that no list names; poly_probed's hand counts == the registry's counts. The first
                    four refuse an empty set (D64's rule).
measured          pg_description over the schema's 14 public `%_type` columns: 0 carry a stored description. The
                    vocabularies exist in migration SOURCE text and Java constants and nowhere else, so D69 §2's
                    "column comments" sentence is corrected in D69 itself — the schema holds neither enforcement
                    nor documentation for eleven of its twelve pairs.
plants            two files, one database, the same rows: P0 HEAD clean 185 · P1 HEAD + legal api_key grant =
                    2 reds (the false orphan red, + traffic) · P2 D71 file + the same rows = 1 red (traffic only,
                    the positive control) · P3 HEAD + merchant-typed grant = 186 GREEN (the false green, and it
                    grew) · P4 D71 + the same row = 2 reds, one of them `no unlisted type rides in the seeded
                    data | not in the vocabulary: permission_grants.merchant` · P5 D71 clean = 191.
                  Registry mutations: M1 drop api_key from poly_arms = 2 reds (equality + count) · M2 change
                    poly_probed's 3 to 2 = 1 red (count only — the two comparison rows ask different questions) ·
                    M3 point the policy waiver at `reviews` = 1 red (the waiver row).
                  Live re-reads: P6 create table public.policies -> the waiver goes red with no list edited, and
                    green again after the drop at 191 · P7 delete the location facts -> `unexercised: facts.location`.
                  All eleven re-run end to end on a SECOND freshly built gate database, so none of it rests on one
                    afternoon's output. Kept database dropped afterwards; 0 `nexus_gate*` remain.
gates             scripts/db_gate_fresh.sh (full, background): RESULT: PASS — 191 quality checks on a
                    from-scratch schema (tables=58, migrations=7), plus the truncate probe's two branches. The live
                    databases were not opened. No Java changed; mvn -o test is not affected by this unit.
deliberately not  No api_keys row added to the seed: that would ship a credential-shaped fixture, which is a
                    product-data decision this lane does not own. The arm's reachability is witnessed by
                    MerchantWorkspaceTest.java:404, which counts the grants after a real
                    POST /api/v1/merchant/api-keys. No arm invented for `agent` either — agent_profiles is a
                    workspace's AI configuration, not an authenticatable subject (D12).
next              poly_arms is a hand copy of the four UNIONs, so the equality row catches the registry drifting
                    from the copy and nothing catches the copy drifting from the UNIONs. Named as D71's residue:
                    if the list grows past a dozen arms, generating the probe from the registry becomes the better
                    trade. Unchanged reports: `saved_searches.notify` read by nothing; CommerceApiTest belongs to
                    another stream; the drifted shared `nexus` demo database (15 merchant_user grants, 0 api_keys,
                    3,961 facts against the gate's 5,688) is diagnostic only and was not reseeded.

## 68. A census that only spoke one suffix (2026-09-25)

D66's reference census exists so that a column nobody thought to check cannot stay unmentioned — and it asked
the catalogue in a naming vocabulary: `attname LIKE '%_id'`. The schema answers that question about actor
attribution in a different suffix. Measured over `public`: 11 columns end in `_by`, 7 of them uuid, and **6 of
those 7 carry `REFERENCES users(id)`** — `campaigns.approved_by`, `coupons.created_by`, `coupons.published_by`,
`refunds.approved_by`, `seo_pages.reviewed_by`, `share_links.created_by`. The seventh is
`permission_grants.granted_by` (V1:136, `granted_by uuid,` with nothing after it), and the census could not see
it because of its name.

```
new/changed       data/seed/quality.sql only, +43/-4 lines, 191 -> 192 checks. The census predicate is now a union
                    of two naming shapes, the second one type-gated:
                      (%_id AND <> 'id') OR (%_by AND atttypid = 'uuid'::regtype)
                    The type condition drops campaigns.generated_by / seo_pages.generated_by /
                      trust_signals.detected_by / flyway's installed_by on its own — no exception list, the way
                      D69's pair rule dropped mime_type.
                    granted_by enters ref_registry under the existing `probe` kind (a fourth kind invented for one
                      row would have been a vocabulary for its own sake), and the new check resolves it with a
                      plain LEFT JOIN users — no type arms, an operator is not a polymorphic subject — refusing an
                      empty set on three separate counts (rows carrying an operator, rows carrying none,
                      unresolvable ones).
measured          the census moves 25 -> 26 with no list edited anywhere; the HEAD file on the same database still
                    prints 25 and passes 191. Seed side: 36 grants, all merchant_user, all with a non-null
                    granted_by, 3 distinct operators, 0 outside the seeded users set — and generate.py's own FK
                    self-check map names permission_grants.merchant_id while never naming granted_by, so the
                    artifact that ships the rows was not asking. App side: MerchantService.java:63 passes
                    principal.userId(), MerchantWorkspaceService.java:177 passes operatorId, ApiKeyService.java:67
                    the owner. The drifted demo database resolves too (15 rows, 0 null, 0 unresolvable) — a report
                    about live data, not a gate on the artifact.
plants            P0 D72 clean 192 · P0b HEAD file on the same db 191 · M1 revert the broadening -> 1 red, and it
                    is `the registry names no column the schema has lost | 1 stale of 6 registered`, i.e. the
                    census does not go quiet, the registry goes stale · M2 rename granted_by's registry entry ->
                    `every reference the seed writes is probed or explained | permission_grants.granted_by
                    (36 row(s))` + the stale row · P3 create public.d72_planted(actor_by uuid not null) + 1 row ->
                    census prints 27 with no list edited and the same unregistered-column red, green again after
                    the drop · P1 point every seeded grant's granted_by at a uuid no users row has -> exactly 1
                    red, `36 unresolvable granted_by of 36 grant(s) … granted_by has no FK in the schema`, green
                    after restoring a real operator.
                  P1's plant is coarser than intended and recorded as such: WHERE subject_type='merchant_user'
                    was meant to move a handful of rows, but all 36 seeded grants are merchant_user, so it moved
                    every one. The verdict tests resolution, not proportionality.
gates             scripts/db_gate_fresh.sh (full, background): RESULT: PASS — 192 quality checks on a
                    from-scratch schema (tables=58, migrations=7) plus the truncate probe's two branches. Kept
                    database dropped after the series; 0 nexus_gate* remain. No Java touched.
also              D71's own §5 set a threshold ("past a dozen arms") that this file had already crossed at 15 —
                    corrected in D71's text, marked, with the real trigger restated as an arm whose join shape
                    cannot be expressed by a flat (table, type) list: four of the fifteen already need more than
                    id::text (two collections.kind pins, the active-membership join, the revoked-key filter).
next              the new row's detail carries a hand literal — "(26 on this schema)" printed next to measured 25
                    and 27 in two of the plants — which contradicts itself whenever the schema moves. Same shape
                    as D69's census row. Named for the next pass with its own green witness rather than reworded
                    mid-commit. Unchanged reports: no migration was added for granted_by's missing FK (schema
                    decision, another stream's applied file); `saved_searches.notify` read by nothing;
                    CommerceApiTest belongs to another stream; the drifted shared `nexus` demo database stays
                    diagnostic and unreseeded.

## 69. A detail line that contradicts its own measurement (2026-09-25)

D72's own plant output caught it. Reverting the census broadening printed

```
25 unconstrained *_id column(s) measured from pg_attribute (26 on this schema; the floor is two thirds …)
```

and planting an unregistered column printed the same sentence with 27. Both halves were true and the line read as
a lie, because the second number was a fact about the day the row was written while the first was a fact about the
database in front of it. The floor (`>= 17`, D69's `>= 8`) is correctly a remembered number — that is the whole
mechanism by which a census catches a schema it has stopped seeing — but a *second* remembered number in the prose
was not measuring anything.

```
new/changed       data/seed/quality.sql only, +6/-5 lines, still 192 checks. Both census rows now print the
                    measured count, then the floor they assert, then label the floor's provenance as history
                    ("two thirds of the 25 measured when D66 wrote it"), so no sentence in the output can be a
                    constant dressed as a measurement.
measured          a sweep of every integer inside a quoted detail string in the file: 75 hits, and the class is
                    exactly two. The rest are requirement citations (§55, §111, §155), thresholds the row itself
                    enforces ((0, 20000), > 20 chars, the 21-day horizon, ceiling 400), file:line pointers and
                    uuid literals. `category tree: 10 roots` looks like a member and is not — 10 there is the
                    contract the row asserts (= 10) and its detail already prints roots= with the measured value.
plants            four runs on the kept gate database, nothing else changed: shipped 12 pairs / 26 columns /
                    192 green · + d72_planted(actor_by uuid) -> 27 columns, the unregistered-column red, the
                    census row green on its own floor · + d73_planted_pair(thing_type, thing_id) -> 13 pairs AND
                    27 columns, two reds naming the new pair and the new key (the pair table contributes an *_id
                    column too, which is the two censuses agreeing rather than overlapping) · both dropped ->
                    12 / 26 / 192 green.
gates             scripts/db_gate_fresh.sh (full, background): RESULT: PASS — 192 quality checks on a
                    from-scratch schema (tables=58, migrations=7) plus the truncate probe's two branches. Kept
                    database dropped; 0 nexus_gate* remain. No Java touched.
next              the reason worth carrying forward: a green row whose detail restates a constant trains its
                    reader to ignore the detail, and the detail is the only part of a census row that says what
                    the schema looks like today. Standing reports unchanged: `saved_searches.notify` read by
                    nothing; CommerceApiTest belongs to another stream; the drifted shared `nexus` demo database
                    remains diagnostic-only and unreseeded; the events subject seam (D70) still waits on a
                    contract decision rather than a check.

## 70. The vocabulary the database defends has no data behind it (2026-09-25)

D69 read the schema from the pair side and found one CHECK in twelve. D74 read it from the constraint side:
12 CHECK constraints exist in `public`, eleven compare numbers, timestamps, nullity or a code format, and
exactly one — `share_links.subject_type` — bounds a set of words. Every other enumerated column on the
platform is bounded in one place only: a `Set.of(...)` / `List.of(...)` behind a controller door. The seed
writes those same columns straight from CSV, through none of those doors.

```
new/changed       data/seed/quality.sql only, +133 lines: door_vocab (9 columns transcribed with the file:line
                    of the door that owns each list), vocab_live (a DO loop's per-column GROUP BY over the real
                    table), check_vocab (pg_constraint read live, the ANY(ARRAY[…]) labels parsed back out) and
                    3 rows — does the transcription name columns this schema has, does the generator stay
                    inside the door, do the two enforcement mechanisms agree label for label. 192 -> 195.
measured          5 of the 9 catalogued columns carry rows, over 11 distinct values, none outside its door
                    list; the other 4 (share_links.subject_type, reservations.status, agent_runs.status,
                    conversations.status) carry none — so the only vocabulary the database itself defends
                    guards a table the shipped dataset never loads. moderation_cases.status: door says
                    open|resolved, all 544 seeded cases are open, which also means closeCase's zero-rows branch
                    (ModerationController.java:137 case_already_resolved) cannot be produced from shipped data.
                    auto_action: V1:578 declares none|hide|flag|reject in a comment the parser discards, the
                    build's only writer emits 'none', the seed carries none|flag, and the door serves the
                    column verbatim — hide and reject are producible by nothing here. Reported, not fixed:
                    closing a seeded case would mean inventing a reviewer and a note, and §127 reserves that.
plants            7 runs on the kept gate database. P1 offerings.kind='bundle' -> the containment row red,
                    naming offerings.kind='bundle' (1) · the FIRST P1 attempt is in the record because it was
                    invalid: min(uuid) does not exist on Postgres 16, the plant never applied, and the green it
                    produced was about nothing · P2 drop 'out_of_stock' from the transcription (a copy of the
                    file, data untouched) -> same row red naming offerings.status='out_of_stock' (249), so the
                    detail separates a moving data set from a stale list by its row count · P3 add
                    check (status in ('open','resolved','closed')) -> the CHECK row red, printing both bounded
                    columns and their label counts · P4 the same constraint with the SAME labels -> green with
                    the census count moved 1 -> 2 and nothing edited in the file, which is the live read
                    working · P5a threadz.status and P5b offerings.kinddom -> the existence row red, naming
                    each · final unmutated run: 195 green.
gates             scripts/db_gate_fresh.sh (full, background): RESULT: PASS — 195 quality checks on a
                    from-scratch schema (tables=58, migrations=7), plus the truncate probe's two branches. Kept
                    database dropped afterwards, 0 nexus_gate* remain. No Java touched, so mvn -o test and
                    e2e_fresh.sh were not in scope for this change: nothing served, rendered or authorised
                    moved — the gate reads the same seed bytes and the same schema.
next              the residue worth carrying: (a) there is no census of text columns whose *data* is bounded
                    while no door names them (users.role, merchants.status, reviews.status, documents.kind,
                    resource_pools.kind, categories.kind, tenants.status, user_preferences.kind|source|scope,
                    offerings.price_source, moderation_cases.auto_action and the provenance columns) — bounded
                    in practice, invisible to this gate by construction, and named rather than listed with
                    values nobody authorised; (b) a transcription over an empty table answers only to its
                    existence row, so 4 of the 9 door lists could drift unnoticed; (c) the polymorphic
                    subject_type columns stay in poly_vocab on purpose — two hand lists of one vocabulary would
                    need a third check to keep them honest. Standing reports unchanged: `saved_searches.notify`
                    read by nothing; CommerceApiTest belongs to another stream; the drifted shared `nexus` demo
                    database stays diagnostic-only and unreseeded; the events subject seam (D70) waits on a
                    contract decision, not a check.

## 71. Forty columns the data bounds and no door names (2026-09-25)

D74 closed by naming what it could not see: the gate catalogued the nine columns a Java door enumerates, and
had no way to say which *other* text columns the shipped dataset bounds by habit. So the two new rows ask the
data instead of the code — for every text column of every base table, how many distinct values does the seed
actually carry? — and require an answer by name for each column the data bounds. The answer, measured here for
the first time: 40 columns are bounded by the dataset, and only 6 of them are bounded by anything a program
wrote.

```
new/changed       data/seed/quality.sql only, +175 lines: vocab_data (a DO loop over pg_attribute, one
                    count(DISTINCT)/count(*)/max(length) GROUP BY per text column), vocab_win (the window's
                    three terms written in one place, so both rows and both details read the same predicate),
                    vocab_answer (44 hand rows: table, column, one of four kinds, and the file:line or probe it
                    leans on) and is_door/is_poly/in_win computed every run from D74's door_vocab, D71's
                    poly_cat and vocab_win — an answer is never trusted to its own label. 195 -> 197 checks.
measured          232 text columns over 58 base tables, ~5 seconds: the 57 this build writes plus the gate's
                    own schema_migrations, which the census scans and counts like any other (its `version` is
                    text, 7 values over 7 rows) and asks nothing of, because the row floor rejects it. `n<=12`
                    alone catches 75 columns, and most are free text that only looks bounded in a small table —
                    four collections give collections.title four values, five users give users.phone five — so
                    the window is three terms together (>=20 rows, <=12 values, <=1 value per 4 rows): 40
                    columns. 19 more carry 2..12 values below the row floor. Of the 44 answers, 9 name a
                    mechanism (6 inside the window: 3 door, 3 poly; 3 more over demo tables too small for the
                    window to catch) while 35 say plainly that nothing in this build bounds the column. Two
                    columns are NULL on every row they sit on — documents.error across 1040 rows, which the
                    window therefore catches and answers, and tenants.region_code across 1 row, which it does
                    not — and both stay in the count rather than being filtered out. Reported, not fixed:
                    offering_relations (1,162 rows, 3 relation kinds) is named by zero code paths outside V1's
                    DDL and the seed; chunks.embed_model has zero occurrences in services/platform/src;
                    reviews.status (pending|published|flagged) and ModerationController's DECISIONS
                    (published|rejected|flagged) are two 3-word lists sharing 2 words, so `pending` is a state
                    no door can write and `rejected` a state no row has — D74's moderation_cases asymmetry,
                    second instance. Narrowing the census's own blind spot by reading nexus_test (no writes):
                    the same 232 text columns there, plus 5 character varying and 0 character — all five
                    belonging to flyway_schema_history, which is itself a finding: that database carries two
                    migration ledgers (schema_migrations listing V1..V6, one hand-written flyway row at
                    version 6 saying "infra-owned V1/V2 applied by scripts/db_apply_migrations.sh") while
                    share_links from V7 is present, so "how migrated is this database?" answers 6, 6-for-
                    another-tool's-sake and 7-in-objects.
plants            6 runs on the kept gate database. Q1 add a text column to categories (77 rows) -> the window
                    row red naming categories.d75_flavour, census 40 of 232 -> 41 of 233 with nothing else
                    edited. The first Q1 attempt is in the record because it was only half valid: its UPDATE
                    died on `function min(uuid) does not exist` — D74's lesson, repeated one unit later — so
                    the red it printed was about an all-NULL column and the plant was re-applied with two real
                    values · Q5 update categories.kind to 77 distinct values -> the answer row red naming
                    categories.kind (none): no list was edited, the *data* moved a column out of the window and
                    the hand answer written about it went red by itself, which is what separates this from a
                    static exemption list · Q2 merchants.plan answered 'door' with no door holding it -> red,
                    with the counts shifting 5->6 door and 34->33 none · Q3 favorites.subject_type answered
                    'maybe', a kind nothing reads -> red · Q4 drop offerings.status from D74's door_vocab ->
                    TWO rows red, the existence row naming offeringz.status and the answer row refusing the
                    orphan, i.e. the two catalogues answering to each other · final unmutated run over an
                    untouched database: 197 green.
gates             scripts/db_gate_fresh.sh (full, background) twice: once for the block as planted, once after
                    the comment-only correction above — RESULT: PASS — 197 quality checks on a from-scratch
                    schema (tables=58, migrations=7), plus the seed truncate shown clearing an empty stranger
                    and refusing one that holds rows. Kept database dropped afterwards, 0 nexus_gate* remain.
                    No Java touched, so mvn -o test and e2e_fresh.sh were not in scope for this change: the
                    gate reads the same seed bytes and the same schema, and nothing served or rendered moved.
next              residue worth carrying: (a) the window is a judgement written as three numbers — move them
                    and a different set of columns must be answered — and 19 columns sit just under the row
                    floor, of which 4 are answered by name because a door or a probe already names them and 15
                    are simply not asked about; (b) vocab_answer is a transcription again: it reddens for a
                    mechanism that vanished, a kind nothing reads, or a windowed column left silent, but a
                    column whose type stops being text leaves the census and takes its answer with it —
                    measured, so the size of that gap is 5 columns and all five are another tool's bookkeeping;
                    (c) widest is computed for all 232 columns and asserted by no row: this gate counts
                    values, not widths. Standing reports unchanged: `saved_searches.notify` read by nothing;
                    CommerceApiTest belongs to another stream; the drifted shared `nexus` demo database stays
                    diagnostic-only and unreseeded; the events subject seam (D70) waits on a contract decision,
                    not a check; and now the split migration ledger in `nexus_test`, reported to the
                    infrastructure lane rather than reconciled here.


## 72. The projections the app reads through carry nothing, and now say so (2026-09-25)

D75 counted values in stored columns; the shipped build also reads through two views, and nothing had measured
what they carry. The new rows census every column of every view in `public`, exactly as D75 does every text
column of every base table, and require an answer by name that is re-read against the census each run. The
answer, measured for the first time: `v_merchant_funnel` is 520 rows whose only varying column is the
merchant id — six counters sit at the constant 0 and `tenant_id` at the one demo tenant — while `v_north_star`
has **zero rows**, so its five columns are empty by absence rather than by value.

```
new/changed       data/seed/quality.sql only, +160 lines: view_data (a nested DO loop over pg_class
                    relkind='v' x pg_attribute, one count(*)/count(DISTINCT col::text)/count(col)/min/max
                    aggregate per view column), view_answer (13 hand rows: view, column, one of three kinds,
                    the literal a `const` claims, and a non-blank reason) and is_const/is_var/is_empty
                    recomputed every run from the census. 197 -> 199 checks; the block itself costs 0.6s
                    against D75's ~5s.
measured          the read sites are few enough to name: `from v_merchant_funnel` at
                    AnalyticsRepository.java:41 and `from v_north_star` at
                    AdminSearchAnalyticsRepository.java:38 and :48 — three SQL sites — while two response
                    fields publish the projection's name to the client (`funnel_source` at
                    MerchantOverviewController.java:68 and MerchantContentController.java:410, `source` at
                    AdminSearchAnalyticsController.java:85). MerchantAnalyticsRepository, the file that
                    mentions the funnel most in prose, selects from events/reservations/orders and is not a
                    consumer of it. The zeros are by rule, not by oversight: D64's fabrication guard computes
                    the seed anchor's FK closure, sweeps the 29 tables outside it and fails if any holds a
                    row, so events/orders/reservations/carts/payments are empty by construction and every
                    counter that aggregates them is 0; the funnel's `reservations` arm stacks a second cause,
                    because V3 counts only confirmed|completed and D26 established that no route moves a
                    booking into either. §109 forbids fake transactions outright while the next sentence
                    allows clearly-marked demo data — seeding a plausible order history would fill both views
                    and would be the thing the guard exists to prevent, and leaving them empty ships every
                    analytics surface showing nothing. That is a product decision and this lane does not make
                    it; the gate makes the consequence visible with the reason attached per arm, so the day
                    traffic is seeded, six `const` answers and five `norows` answers go red by themselves.
plants            9 runs on a kept gate database, over three seams — pre (before the census), mid (between
                    the hand answers and the flag UPDATE), post (after the flags). V1 delete an answer -> the
                    exposure row red naming v_merchant_funnel.clicks · V2 move a claimed literal -> the answer
                    row red, tenant_id (const claims 1) · V3 insert ONE events row named 'view' -> the answer
                    row red over six columns: funnel views (const claims 0) and all five north-star (norows),
                    nothing edited in the answer list itself · V4 create a third view -> the exposure row red
                    naming both of its columns and the census saying 15 column(s) across 3 view(s) · V5 an
                    answer of kind 'maybe' -> red, a vocabulary the block refuses to read · V6 rename the
                    north star away -> BOTH rows red, the moved columns unanswered and the orphaned answers
                    marked ·no such column · V7 blank an answer's reason -> red, marked ·no reason · V8 the
                    mirror of V2, a `varying` claim on a constant column -> red with the kind counts shifting
                    7->6 const, 1->2 varying · V9 an answer for a column no view exposes while every exposed
                    column stays answered -> only the answer row red, marking v_north_star.d76_gone
                    (const claims 0 ·no such column) · baseline and final unmutated: both rows green.
                    Three of the nine were written because the block's own text was wrong, and the drive is
                    where that surfaced: the first V1 detail read "every one answered" next to the column that
                    was not (D73's class, arrived at again), the first draft's exposure row carried a conjunct
                    comparing pg_class's view count with the census's own distinct-view count — the same query
                    counted twice, so no mutation could ever have failed it — and the header comment named a
                    repository that never mentions either view and called grep hits "call sites". The plants
                    taught one more: is_const/is_var/is_empty are materialised once, so V2 stayed GREEN until
                    the third seam existed — a gate that measures into columns can only be falsified at the
                    moment it measures, and the falsifier has to plant on the correct side of that moment.
                    V3's first attempt planted name='d76_view', which the funnel's FILTER (WHERE e.name =
                    'view') never matches, so it reddened the north star only; a plant that misses the
                    predicate it means to disturb is a weak witness, and it was re-run with the name the arm
                    counts.
gates             scripts/db_gate_fresh.sh three times green: RESULT: PASS — 199 quality checks on a
                    from-scratch schema (tables=58, migrations=7), once as planted and once after the
                    comment-only corrections; the third run used --keep to give the drive a database, and the
                    two new rows print green in the official stream's own output ("13 column(s) across 2
                    view(s) the app reads; 0 column(s) left unanswered by this block: none" / "13 answer(s):
                    7 const, 1 varying, 5 over no rows … every answer still holds"). Both kept databases
                    dropped afterwards, 0 nexus_gate* remain. No Java, migration or seeded value touched, so
                    mvn -o test and e2e_fresh.sh were not in scope: the gate reads the same bytes and nothing
                    served or rendered moved.
next              residue worth carrying: (a) the `const 0` answers are true of the shipped dataset and of
                    nothing else — they are the visible half of a §109 decision this lane will not make alone,
                    so the next mover on that question should answer whether the demo seed carries transactions
                    and then re-write these 13 rows in the same commit; (b) `norows` is correct only while
                    D64's guard keeps `events` empty — the two rows would fail together if that guard were
                    loosened without touching the answers, which is the intended coupling, not a coincidence;
                    (c) the census collects `nulls`, `low`/`high` and the column's declared type and asserts
                    none of them — no row here cares whether a column is NULL-heavy or what a date column
                    spans, so the same "counts values, not widths" residue D75 left stands; (d) a view that
                    stops being a view (a table swap, a rename into another schema) leaves the census with its
                    answer, exactly D75's residue (b) one layer up, and only a `norows`/`const` claim that no
                    longer matches would notice. Standing reports unchanged: `saved_searches.notify` read by
                    nothing; `no_show` named once by a door list with no reader; CommerceApiTest belongs to
                    another stream; the drifted shared `nexus` demo database stays diagnostic-only and
                    unreseeded; the events subject seam (D70) waits on a contract decision, not a check; and
                    the split migration ledger in `nexus_test` belongs to the infrastructure lane.

## 73. A view column's kind is read from the census, not chosen by the author (2026-09-25)

§72 shipped three hand-set kinds for the 13 columns of the two served views and refused a fourth. This unit
tested the half of that claim nobody had measured — not *can an invented kind be refused* (it can) but **does
every shape the data can take have a name**. It does not: on the (rows, distinct values) plane the three kinds
cover three cells of five, and the two homeless ones are produced by exactly the change §72 defers to §109. So
the kind is now *derived* from the census, a hand answer must name the kind the data puts its column in, and the
two kinds the demo does not exercise are exempted by name with a reason that is re-read against the derivation
every run.

```
measured          the plane first, before any edit. Shipped funnel: merchant_id (520 rows, 520 values) and
                    seven single-valued columns. Plant 1 — one 'view' event for 260 of the 520 merchants —
                    puts v_merchant_funnel.views at (520 rows, 2 values), where §72's block reports
                    `const=NO varying=NO norows=NO`: no legal answer exists, and the answer row goes red
                    accusing that column. Plant 2 — a view column written as NULL::text over the same 520 rows
                    — sits at (520 rows, 0 values) and reddened the answer row under ALL THREE kinds, three
                    separate attempts naming the same column each time. The only remedy a future maintainer
                    could reach for was deleting the check. Both plants are reachable by the very change §72
                    says someone may decide to make (seed transactions/traffic), which is what made this a
                    defect rather than a taste question. One false start, same class as D65's plants: the first
                    probe view was created AFTER the census ran, so the reds printed `no such column` — they
                    tested the dangling-answer conjunct, not the empty cell — and the fixture had to move to
                    the pre-census seam to be legal in every dimension except the one under test.
new/changed       data/seed/quality.sql only, +143/-52. The three materialised flags (is_const/is_var/is_empty)
                    are gone; view_kind derives the kind from nothing but (total, n):
                    norows | allnull | const | varying | sparse, plus an ELSE that prints
                    'UNNAMED-'||n||'-of-'||total. `sparse` and `allnull` are the two cells §72 had no word
                    for. Kept from §72 rather than traded away: a closed vocabulary (an invented label simply
                    never matches the derivation) and `const` answers still carrying the literal they claim, so
                    a column whose single value moves reddens its row. Gained with the derivation: one fewer
                    seam — labels are read at check time, so an answer moved after the derivation is red (W8),
                    which is the exact plant that stayed green in §72 until a third seam existed. New row 3
                    'a view kind is exercised or exempted' over view_vocab (5 names; allnull and sparse exempt
                    with written reasons): four refusals — a derived kind no vocab row names, a vocab name the
                    CASE can never produce, an exemption whose cell is NOT empty, an unexercised name with a
                    blank reason. 199 -> 200 checks; re-timed on the kept database, the block costs 0.49s.
                    The ELSE branch is unreachable by arithmetic (n is never negative nor strictly between 0 and
                    1) and no qc row asserts it empty — it is a tripwire inside the derivation, not a check
                    about it, because a predicate that can only pass is the thing §72 deleted one unit earlier.
plants            11 runs against the shipped text (the drive slices the block out of quality.sql itself), on a
                    kept from-scratch gate database, over three seams, with a footer that refuses to report
                    anything unless all three rows exist. W1 the 260-event plant with no edit to the answer list
                    -> TWO rows red: `v_merchant_funnel.views answered const, the census derives sparse` and the
                    vocab row's `norows = UNUSED, no reason` / `sparse = 1 column(s)` — seeding withdraws an
                    exemption by itself · W2 the same plant with that answer rewritten -> row 1 green, views no
                    longer an offender · W3 an all-NULL column answered `allnull` -> rows 1 and 2 green over 15
                    columns ("allnull 1, const 7, norows 5, varying 2 — offenders: none") and ONLY row 3 red for
                    the exemption it withdrew: the new home fits, the stale exemption does not · W4 'maybe' ->
                    `answered maybe, the census derives const` · W5 a blanked reason -> `orders gives no reason`
                    · W6 the sparse exemption blanked while its cell is still empty -> `sparse = UNUSED, no
                    reason` · W7 'const' deleted from the vocabulary while every answer still matches its
                    derived kind -> only the vocab row red, `4 kind(s) in the vocabulary, 3 of them actually
                    derived` · W8 a label moved AFTER the derivation -> red, the seam §72 needed a third of ·
                    W9 an answer deleted -> `1 column(s) left unanswered: v_merchant_funnel.clicks (520 row(s),
                    1 value(s))` · W10 the north star renamed away -> BOTH rows red naming opposite directions:
                    row 1 `5 column(s) left unanswered … d77_moved.day (0 row(s), 0 value(s))` and row 2
                    `v_north_star.day answered norows, the census derives no such column`. W10 is what §72's
                    residue (d) asked for: a view that stops being a view was caught there only because a
                    `norows`/`const` *value claim* went stale; now the census enumerates views by name, so a
                    rename arrives as a stranger to row 1 and as a dangling answer to row 2. Baseline and final
                    unmutated: three rows green; state after the drive `events=0 public views=2 named
                    v_merchant_funnel+v_north_star leftover-d77_moved=0`.
gates             scripts/db_gate_fresh.sh --keep twice green over this block — `RESULT: PASS — 200 quality
                    checks on a from-scratch schema (tables=58, migrations=7)` — once before a comment
                    de-duplication pass and once over the text that ships (the second block had one repeated
                    comment deleted, no SQL moved). The three rows were read off the kept database and print
                    PASS there: `13 column(s) across 2 view(s) the app reads; 0 column(s) left unanswered` /
                    `13 answer(s) over 13 census column(s) … const 7, norows 5, varying 1 — offenders: none` /
                    `5 kind(s) in the vocabulary, 3 of them actually derived by the census: allnull = exempted
                    with a reason, const = 7 column(s), norows = 5 column(s), sparse = exempted with a reason,
                    varying = 1 column(s) … offenders: none`. All kept gate databases dropped (0 nexus_gate*
                    remain); `nexus_funnel_probe` in the same container is not this lane's and was left alone.
                    No Java, migration or seeded value changed, so mvn -o test and e2e_fresh.sh were not in
                    scope: the gate reads the same bytes and nothing served or rendered moved.
next              residue worth carrying: (a) the derivation reads only `count(*)` and `count(DISTINCT col::text)`
                    — `nulls`, `low`/`high` and the declared type are collected and asserted by no row except
                    `low`, which `const` answers must name, so §72's "counts values, not widths" residue stands;
                    (b) the ELSE tripwire has no witness, because no legal plant can reach it — it is defended
                    by arithmetic and by its own offender string, and saying so is the honest version of
                    leaving it; (c) a view *swapped for a table* should redden row 2 by W10's mechanism (the
                    census filters `relkind = 'v'`) but that swap was reasoned, not performed; (d) the sparse
                    and allnull exemptions are live the moment the seed carries traffic — the next mover on the
                    §109 question must withdraw them and rewrite the 13 answers in the same commit, which is now
                    enforced by row 3 rather than by this sentence. Standing reports unchanged: `saved_searches.notify`
                    read by nothing; `no_show` named once by a door list with no reader; CommerceApiTest belongs
                    to another stream; the drifted shared `nexus` demo database stays diagnostic-only and
                    unreseeded; the events subject seam (D70) waits on a contract decision; the split migration
                    ledger in `nexus_test` belongs to the infrastructure lane.
```

## 74. The census said "every text column" and spoke one string type (2026-09-25)

§71's census counted distinct values for *"every text column of every base table"* — 232 of them — and the
predicate behind that sentence was `atttypid = 'text'::regtype`, which is one type rather than a kind of data.
Measured against `pg_type.typcategory = 'S'` (domains resolved through `typbasetype`), a from-scratch schema
carries **233 string columns: 232 text and 1 citext — `users.email`**, the column V1:6 turns citext on "for
case-insensitive emails" to make case-insensitive. So the census skipped the one string column whose idea of
"the same value" is not the idea its own details print: citext folds case, `col::text` does not, and
`count(DISTINCT col)` is the first while the printed numbers read like the second. This unit measured the type
plane before editing, widened the predicate to it, and turned "which reading was taken" into two rows.

```
measured          233 string columns over 58 base tables: 232 text, 1 citext (users.email), 0 typed on a
                    domain. users.email carries 5 rows, 5 distinct under citext, 5 under the cast, widest 24,
                    narrowest 21, 0 rows with an uppercase letter — demo.consumer@example.hk through
                    demo.admin@example.hk, every one lowercase. The two readings agree here for two reasons
                    outside this block: the seed never writes case variance, and V4:44's unique partial index
                    on (tenant_id, email) (which replaced V1:46's global one) makes two addresses differing
                    only by case impossible to insert. The column also sits below the window's row floor
                    (5 < 20), so §71's window asked nothing of it either way. Re-measuring the census also
                    killed two remembered counts in §71's own header and one silence: `n <= 12` alone catches
                    204 of 233 columns, not the 75 that sentence printed (75 was not reproducible under any
                    of four readings on a fresh or a drifted database); the below-the-floor 2..12 set is 20
                    columns, not 19, because users.email is the twentieth; and of the 130 columns answering 0
                    distinct values, 128 are 0 because their TABLE is empty — 35 such tables, none populated
                    by the shipped seed. §70's lesson about detail text applies to prose one layer up.
new/changed       data/seed/quality.sql only. The census gains `btype`, `n_txt`, `n_upper` and a
                    typcategory/typbasetype predicate; for a column that is not plain `text` it takes a second
                    reading (`count(DISTINCT col::text)`) plus a count of rows carrying an uppercase letter,
                    and pays nothing extra where the two questions are one. `str_type` declares the readings
                    owed per base type with the reason written next to it (`text` = one, `citext` = two). Two
                    new rows: 'the string census declares a reading for every type it catches' refuses a
                    caught-but-undeclared type, a declared-but-absent type (a stale vocabulary surviving a
                    schema change) and a reading name the census cannot take; 'a census that folds case reports
                    both readings and which one the demo exercises' requires the pair to exist, the two
                    readings to AGREE, and no uppercase letter anywhere in a twice-read column. §71's row was
                    renamed from `a bounded text column...` to `a bounded string column...` in both directions
                    (grep: 0 old hits, 1 new) because the window now spans 233 columns. 200 -> 202 checks. The
                    widening's cost is one two-aggregate query over one five-row column: timed twice each way
                    on the kept database, the census took 3.1s and 5.2s with the second reading and 4.2s and
                    4.9s without it, i.e. inside its own noise.
plants            7 runs of the shipped file — sliced out of quality.sql at the census and at str_type, so
                    every line is bytes that ship — on a kept from-scratch gate database named on the drive's
                    command line, each with its full red detail printed. P1 `DELETE FROM vocab_data WHERE
                    btype <> 'text'` (D75's predicate restored) -> both rows red: `citext is declared but no
                    column carries it — the census lost a type the vocabulary still answers for` and `0
                    column(s) measured twice` · P2 users.email typed as `varchar` -> row 1 red with BOTH
                    offender kinds at once (`the census caught a varchar column (users.email) and no reading
                    declares that type` plus the now-stale citext term) · P3 one seeded address uppercased
                    before the census ran -> ONLY row 2 red, `5 distinct under citext, 5 distinct under ::text,
                    1 row(s) carrying an uppercase letter` — the readings still agree, so the third term is the
                    one with teeth · P4 the second reading blanked -> `users.email was never measured under
                    citext, the pair is missing`, i.e. a missing measurement is never read as agreement · P5
                    V4:44's index dropped and the first user given the last user's address folded to uppercase
                    -> `citext sees 4 value(s) while the cast sees 5` AND the uppercase term: the conjunct that
                    the index enforced outside the gate is falsified inside the data, which is the only way to
                    show that term has teeth. W0 and final: 202 green. Two false starts are in the record:
                    row 2's `string_agg(expr, ', ' FROM …)` closed the aggregate after its FROM, died with
                    `syntax error at or near "FROM"`, and — because psql with ON_ERROR_STOP=0 exits 3 without
                    running the file's hard gate — that state is INVALID, not green, which is now what the
                    drive asserts; and P5's first cleanup ran `lower(email)` over the whole table, collapsing
                    the case-variant pair into a genuine duplicate so the index could not be recreated, while
                    the drive's own `final` run printed 202 green over that damaged database
                    (`distinct_citext=4 uniq_index=0`). The restore now writes the planted row's original
                    address back verbatim and says so: `users=5 distinct_citext=5 distinct_text=5 uppercase=0
                    uniq_index=1`, `P5 planted on demo.consumer@example.hk, restored to
                    demo.consumer@example.hk -> VERBATIM`.
gates             scripts/db_gate_fresh.sh --keep three times green over this block — `RESULT: PASS — 202
                    quality checks on a from-scratch schema (tables=58, migrations=7)` — 200 -> 202 because two
                    rows were added and none removed (§71's row was renamed, not replaced). The first two runs
                    were before four header-comment corrections that moved no SQL; the third, whose database is
                    `nexus_gate_102747_…`, ran over the text that ships and is the same database the seven-plant
                    matrix above ran against. The three rows were read off it and print there: `40 of 233 string
                    column(s)
                    are bounded by the data (window: <=12 distinct, >=20 rows, <=1 value per 4 rows), 3 of them
                    by a door list and 3 by the polymorphic registry; every one of them answered above` /
                    `233 string column(s) over 2 base type(s), declared under 2 reading rule(s): citext 1
                    column(s), read two, text 232 column(s), read one — offenders: none` / `1 column(s)
                    measured twice: users.email (5 row(s), 5 distinct under citext, 5 distinct under ::text, 0
                    row(s) carrying an uppercase letter) — offenders: none`. All kept gate databases dropped
                    (0 nexus_gate* remain); `nexus_funnel_probe` and the drifted `nexus` demo database belong
                    to other streams and were read from, never written to. No Java, migration or seeded value
                    changed, so mvn -o test and e2e_fresh.sh were not in scope.
next              residue worth carrying: (a) the census still stops at the `S` category — `name`-type and
                    composite columns are uncounted, as is any column an ad-hoc DDL adds to the drifted demo
                    database; (b) `n_upper = 0` is DECLARED for plain text columns, not measured, so nobody
                    should read that column as "has no uppercase letters" — row 2 reads it only where
                    `reads = 'two'`; (c) the agreement on users.email is an accident of lowercase seed data
                    plus a unique index, so the first mixed-case address in a future seed reddens row 2 by P3
                    and the fix is to answer for the divergence, not to delete the term; (d) D74's
                    CHECK-bounded census still prints "text column(s)" for whatever its constraint parser
                    finds — the widened census now knows the type of every string column, so that label is one
                    measured term away from being an assertion, and no citext column carries such a CHECK
                    today. Standing reports unchanged: `saved_searches.notify` read by nothing; `no_show` named
                    once by a door list with no reader; CommerceApiTest belongs to another stream; the split
                    migration ledger in `nexus_test` belongs to the infrastructure lane; the events subject
                    seam (D70) waits on a contract decision.
```

## 75. A probe over an empty table is not green — it is absent (2026-09-25)

D65–D71 built the polymorphic resolution: declare the types a `<stem>_id` may hold, write one UNION arm per
type, resolve each against the table that type names. §71's census counted 26 unprotected reference columns and
§72's registry named what resolves them. What nobody asked of the probes themselves is the question §70 and §71
asked of every other check: **is there a row behind it**. The orphan probes are `… FROM g GROUP BY t`, so a type
the seed does not file emits not a green check but no check at all. Measured on the kept from-scratch database:
15 arms are declared, 9 `orphan: …` checks exist, and six arms — `facts.review`,
`moderation_cases.merchant|document|message`, `permission_grants.user|api_key` — are resolution rules asserted
over zero rows, nameable by nothing in the ledger.

```
measured          poly_arms 15 declared; qc carries 9 rows named `orphan: …`; the exercised nine are facts
                    location=684 / merchant=2080 / offering=2924, favorites merchant=12 / offering=4 /
                    collection=1 / guide=1, moderation_cases review=544, permission_grants merchant_user=36.
                    The same seam was walked from the reference side first and killed a planned unit: of the 26
                    unprotected columns, 7 have a column of the same name on the child side of a real FK
                    somewhere in this schema and 19 do not — and all 7 of the walkable ones sit in the 19 whose
                    tables D64's fabrication guard keeps EMPTY, while the 6 that carry values are exactly the
                    ones with no schema-named twin (the polymorphic subject_ids, granted_by, provider_id).
                    Walking by name would have accused user_identities.provider_id — `password/demo:admin`,
                    an identity that lives outside this database by V4's design — of dangling. The target a
                    name implies is not the target a column means, so no target row was written.
new/changed       data/seed/quality.sql only. `arm_seen` joins the declared arms to poly_types (the census the
                    probes group over) and left-joins the hand list `arm_idle(tbl, arm, writer, why)`, where
                    `writer` is what makes each waiver checkable: `none` = no code path in the build files such
                    a row (no literal `review` subject type reaches facts.record; ModerationController.java:130
                    refuses every non-review case), `build` = the build files it and the demo never does
                    (MerchantService.java:63, MerchantWorkspaceService.java:177, ApiKeyService.java:67). Two
                    rows: 'an arm the seed never files is waived by name and by writer' refuses an unwaived
                    silence, a waiver whose arm now carries rows (the exemption re-reads its own data, §73's
                    rule), a blank `why`, a `writer` outside the two states, and a waiver naming an arm no
                    longer declared; 'every probe family resolves at least one armed type' prints the per-family
                    reading no other row carries. 202 -> 204 checks.
plants            8 runs of the shipped bytes, three seams (before every probe, after the waiver list, after the
                    ledger), each printing the gate's verdict and the number of orphan rows it emitted.
                    A1 `facts.review` given 7 rows -> row 1 red, `10 exercised … 5 waived`: filing a review fact
                    withdraws its own waiver · A2 the `permission_grants.user` waiver deleted -> row 1 red, an
                    unwaived silence · A3 all four favourites arms forced to zero -> BOTH rows red, `4 idle and
                    unwaived` and `favorites ships 18 row(s) across 0 of 4 arm(s)` · A4 `writer='maybe'` ->
                    `facts.review (writer maybe)` · A5 `why=''` -> an exemption with no reason · A6 the
                    `facts.review` waiver renamed to `facts.policy` -> both halves at once: not a declared arm,
                    and review now idle and unwaived · **A7 the data plant: all 18 favourite rows deleted before
                    the probes ran — checks emitted 204 -> 200, orphan rows 9 -> 5, and four rows red: D71's
                    `an arm claimed seeded is a type the data still carries` (`unexercised: favorites.guide,
                    favorites.merchant, favorites.collection, favorites.offering`), `favourites point at a
                    renderable row` (`0 unreachable of 0 favourite(s)`), and both rows written here.** Baseline
                    and final 204 green, 9 orphan rows, database restored
                    (`favorites=18 by type=collection=1,guide=1,offering=4,merchant=12 | stray d79 schema=0`).
                    One false start is in the record and it is the same trap as §73's late probe view: the first
                    A7 deleted the favourites AFTER the probes had run, so the ledger still showed 204 checks and
                    the plant tested nothing — a fixture has to be reachable in every dimension except the one
                    under test, and "the probes see the same data as the census" is one of them.
gates             scripts/db_gate_fresh.sh --keep green over the shipped text — `204 quality checks passed
                    against a from-scratch schema (tables=58, migrations=7)` — with the two new rows read off
                    the kept database: `15 declared arm(s): 9 exercised by the shipped seed, 6 idle and waived,
                    0 idle and unwaived: … | facts.review (writer none), moderation_cases.document (writer none),
                    moderation_cases.merchant (writer none), moderation_cases.message (writer none),
                    permission_grants.api_key (writer build), permission_grants.user (writer build) —
                    offenders: none` and `facts ships 5688 row(s) across 3 of 4 arm(s), favorites ships 18
                    row(s) across 4 of 4 arm(s), moderation_cases ships 544 row(s) across 1 of 4 arm(s),
                    permission_grants ships 36 row(s) across 1 of 3 arm(s)`. Kept gate databases dropped when
                    this unit closes; the drifted `nexus` demo database and `nexus_funnel_probe` belong to other
                    streams and were read from, never written to. No Java, migration or seeded value changed, so
                    mvn -o test and e2e_fresh.sh were out of scope.
next              residue worth carrying: (a) `poly_arms` is a hand copy of what each probe's UNION actually
                    reads — §71 named that and this unit inherits it, so an arm added to a probe without being
                    declared here stays invisible to row 1 (the orphan probe itself would still resolve its
                    rows, which is the stronger half of the seam); (b) `writer='none'` is a claim about the Java
                    sources, re-read here only through the data: the day a `review` fact is filed, row 1 reddens
                    whether or not the sentence about the writers was still true; (c) the family row overlaps
                    D71's claimed-seed row and A7 shows both firing — it is kept for the per-family sentence,
                    stated rather than hidden; (d) the 19 unprotected references in D64-empty tables remain
                    unwalkable by construction, which is the same §109 line D76 drew: traffic is absent by rule,
                    so every check that reads traffic-shaped columns is reading an emptiness someone chose.
                    Standing reports unchanged: `saved_searches.notify` read by nothing; `no_show` named once by
                    a door list with no reader; CommerceApiTest belongs to another stream; the split migration
                    ledger in `nexus_test` belongs to the infrastructure lane; the events subject seam (D70)
                    waits on a contract decision.
```

## 76. The synthetic stamp lives in twelve columns and the row enforcing it read three (2026-09-25)

§75's drive kept pointing at the same shape of hole — a check whose subjects come from the data can silently
have fewer subjects than its name implies. This unit turns that on the §109 promise itself: the file has
carried since the seed's first provenance work two hand lists naming where the synthetic marker lives, six
names in all. Opened against the shipped data, the marker lives in **twelve jsonb columns across twenty
(column, key) pairs** — and the enforcing row reads three of them.

```
measured          62 jsonb columns; 40 never filled (every one in a table D64's fabrication guard keeps empty);
                    20 pairs claiming a provenance-or-synthetic axis across 12 columns: data_origin=12
                    (chunks.metadata, collections.seo, documents.metadata, facts.value, locations.geo_properties,
                    merchants.attributes, merchants.contact, merchants.seo, offerings.attributes,
                    resource_pools.attributes, reviews.moderation, tenants.config), synthetic=4, demo=3,
                    demo_login_role=1. The unchecked nine include reviews.moderation — the stamp on ALL 11000
                    reviews, the biggest home in the dataset — and facts.value on 5004. The axis collision was
                    then measured pair by pair rather than assumed: source=merchant 2513, observed 1800,
                    inferred 171 rows whose payload says data_origin=demo (that is the §19 column and the §109
                    stamp disagreeing, correctly, on 4484 rows), 520 where source is itself demo, and 684
                    address-shaped facts that keep the promise under `synthetic: true` instead — so 5004+684 =
                    every fact row stamped, no single key on all of them. generate.py is the witness that this
                    is one call, two axes: line 900 ends `"data_origin": "demo"}, None, None, "merchant",
                    ttl_h=24*30`. Also measured, reported, NOT touched: CollectionsRepository.java:68 tests
                    `seo->>'generated_by'` against ai|editor|creator while no shipped payload carries
                    `generated_by` at all (0 of 62 columns) — that read belongs to the §8 door's stream.
new/changed       data/seed/quality.sql only, +228/-0. `marker_cat` (one row per pattern-matching key a filled
                    jsonb column carries: the column's rows, how many carry that key, the values it holds),
                    `marker_cov` (per COLUMN, counting rows carrying any of that column's answered stamp keys —
                    because the promise is about rows and a column may keep it in two spellings) and
                    `marker_axis` (the hand list that has to stay hand-written: SQL cannot tell `demo` in a
                    pool's attributes from `demo_login_role` in a merchant's; each answer names an axis in
                    {synthetic-stamp, provenance, not-a-marker} plus a non-blank reason). Three rows: the census
                    and the answers named for each other in both directions, with a stale answer reddening; the
                    stamp's value discipline and per-column coverage (19 stamped pairs over 12 columns, 46792
                    markers, every stamped column complete); and the facts term, which prints the pair counts
                    and refuses a stamp slot holding a provenance word. 204 -> 207 checks.
plants            9 runs of the shipped bytes at three seams (before the census, between the key census and the
                    coverage census, and after both), each printing the checks emitted and the gate's verdict,
                    every data plant restoring its row and being re-read afterwards. W0 207 green ·
                    P1 one chunk gains `synthetic_data` -> row 1 `the data carries chunks.metadata.synthetic_data
                    (1 row(s), values true) and no axis answers for it` · P2 the census loses a key an answer
                    names -> `tenants.config.data_origin is answered as synthetic-stamp but the payloads no
                    longer carry that key at all` · P3 one review loses both spellings -> row 2 `reviews.
                    moderation is stamped on only 10999 of 11000 row(s): 1 row(s) carry no stamp key under any
                    name` · P4 the stamp slot set to `merchant` on one fact — the well-meaning wrong-way fix ->
                    rows 2 AND 3, `facts.value.data_origin carries value(s) demo,merchant, which is not the §109
                    stamp` and `a fact payload carries data_origin = merchant`, with the by-design 4484 still
                    printed · P5 an axis renamed `maybe` -> `claims axis 'maybe', which is not one of the three
                    this block knows` · P6 a reason blanked -> `the axis of reviews.moderation.data_origin
                    carries no reason` · P7 `facts.source='scraper'` -> row 3, and its own text now reads
                    `source = merchant=3197, observed=1800, demo=520, inferred=171, scraper=1` · final 207 green
                    with `unstamped_reviews=0 non_demo_stamps=0 d80_schema=0`. One false start is in the record
                    and the new rows caught it: the first P4 wrote `UPDATE facts … FROM facts f WHERE f.id =
                    (SELECT id FROM snap)` — an `UPDATE … FROM` source is not chained to the target unless the
                    WHERE says so — so all 5688 rows were rewritten from one row's value and the restore could
                    not undo it. The next run printed SIX reds where none were expected: terms that read live
                    data are the only reason a damaged database is visible at all. The plant now names its
                    target row, and each cleanup is followed by a probe that re-counts what it changed.
gates             scripts/db_gate_fresh.sh --keep green over the shipped text — `RESULT: PASS — 207 quality
                    checks on a from-scratch schema (tables=58, migrations=7)` — and the three rows read off the
                    kept database: `20 (column, key) pair(s) measured across 12 jsonb column(s): data_origin=12,
                    demo=3, demo_login_role=1, synthetic=4; 20 answered by the axis list, each by name —
                    offenders: none` / `19 stamped (column, key) pair(s) over 12 column(s) — the hand list this
                    replaces named 3 — carrying 46792 marker(s) in all; coverage per column: every stamped
                    column is complete; values: each key says demo, or true, wherever it appears` / `5688
                    fact(s): source = merchant=3197, observed=1800, demo=520, inferred=171; value->>data_origin
                    on 5004 row(s), 5004 of them say demo; the two axes disagree on 4484 row(s) BY DESIGN`. Kept
                    gate databases dropped (0 nexus_gate* remain); the drifted `nexus` demo database and
                    `nexus_funnel_probe` were read from and never written. No Java, migration or seeded value
                    changed, so mvn -o test and e2e_fresh.sh were out of scope.
next              residue worth carrying: (a) a marker spelled without `origin|synth|demo|generat` is invisible
                    to the census — the pattern is the definition of the set, and the near-miss is answered
                    (`demo_login_role` → not-a-marker) rather than filtered by narrowing it; (b) `rows` in the
                    coverage count is the table's rows, so an array-valued column that ever gained a stamp key
                    would show 0 of N — today's five array-shaped columns carry none; (c) which axis the
                    product wants INSIDE a fact payload is a contract call about generate.py's output and this
                    unit takes none: row 3 reddens first if anyone moves provenance into the stamp slot, and
                    the §8 `seo->>'generated_by'` read with no writer anywhere stays with its own stream;
                    (d) `merchants.tags` is still a 100-value vocabulary bounded by nothing (§75's window sees
                    arrays not at all), which is the next un-enumerated value space in this schema. Standing
                    reports unchanged: `saved_searches.notify` read by nothing; `no_show` named once by a door
                    list with no reader; CommerceApiTest belongs to another stream; the split migration ledger
                    in `nexus_test` belongs to the infrastructure lane; the events subject seam (D70) waits on
                    a contract decision.
```

## 77. The arrays held the two most vocabulary-shaped columns in the demo, invisible to every census (2026-09-25)

§75 widened the string census to a *category*, which was the right answer to the wrong plane: `text[]` is
category `A` and jsonb is `U`, so the containers have been outside every value-set check since §71 began
counting them. Measured on a from-scratch database, that hid exactly the two things a vocabulary check exists
for — a facet list with no bound anywhere (`merchants.tags`: 520 merchants, 2428 elements, **100 distinct
slugs**, rarest on 2 merchants, commonest on all 520) and a value set bounded only by something no check reads
(`tenants.locales`: 3 elements, matching V1:21's `DEFAULT ARRAY['en','zh-HK','zh-CN']` in `pg_attrdef`) — plus
four object arrays whose elements all turn out to share one key signature, and `reviews.photos`, an empty array
on all 11000 rows.

```
measured          arr_cat finds 11 array columns (6 text[], 5 jsonb holding arrays). text[]: merchants.tags
                    2428/100 (rows 520), tenants.locales 3/3 (1 row), and api_keys.scopes, campaigns.channel,
                    eval_cases.tags, external_principals.scopes with 0 rows — all four DEFAULT '{}'::text[].
                    jsonb arrays, elements / distinct / keysets: merchants.images 520/10/1 [alt, credit, url],
                    offerings.images 5534/10/1 [alt, credit, url], offerings.options 4409/3/1 [name, values],
                    collections.items 38/25/1 [note, subject_id, subject_type], reviews.photos 0/0/0 over 11000
                    rows. The door side was read rather than assumed: SeoRepository.java:151 filters
                    `:tag = any(coalesce(m.tags,'{}'::text[]))` behind a slug PATTERN (:50) and no list, so
                    100 tags are bounded by nothing the gate can read; §71's repetition test says they are a
                    vocabulary (24.3 occurrences per value, nothing on a single merchant).
new/changed       data/seed/quality.sql only, +232/-0. arr_cat (rows, rows-with-elements, elements, distinct
                    elements, distinct key signatures and their union, plus the column's catalog DEFAULT text);
                    arr_bound (one hand answer per column, kind ∈ nothing-bounds-it | column-default |
                    payload-shape | never-populated, with the declared element list and a reason). Three rows:
                    the census and the answers named for each other both ways, a blank reason or unknown kind
                    refused, `column-default` checked against the data's element count AND against the DEFAULT
                    text in pg_attrdef, `nothing-bounds-it` allowed only while no ARRAY DEFAULT exists; the
                    object-array row requiring one key signature per column and refusing a payload-shape answer
                    over zero elements or a never-populated answer over 2428; and §71's row floor applied to
                    elements, so a tag on exactly one merchant is named. 207 -> 210 checks.
plants            9 runs at three seams (before the censuses for data, after them for the answers, before the
                    rows), each printing the checks emitted and the gate's verdict. Q1 delete the tags answer ->
                    `the data has an array column merchants.tags (2428 element(s)) and no answer says what
                    bounds it` · Q2 kind='free-text' -> `names kind 'free-text', not one of the four this block
                    knows` · Q3 declare a fourth locale -> both column-default terms fire at once (3 in the data
                    against 4 declared, and `und` missing from the catalog's DEFAULT) · Q4 answer locales as
                    nothing-bounds-it -> `is answered nothing-bounds-it but now carries a DEFAULT of
                    ARRAY['en'::text, …]`, the catalog refuting the answer · Q5 answer tags as never-populated ->
                    the object-array row, on element count alone · Q6 (data) one image element gains a `caption`
                    key -> `merchants.images keysets=2` · Q7 (data) one merchant gains a tag nobody else has ->
                    `the rarest element of merchants.tags is on 1 row` · W0 and final 210 green with the data
                    plants restored and re-counted: `merchants=520 with a 1-row tag=0`,
                    `merchants with a caption key=0`, `d81 schema=0`. The two data plants restore the row they
                    touched from a snapshot table in a schema the gate does not scan, because §75's and §76's
                    lessons both say a restore is only evidence when it is re-read.
gates             scripts/db_gate_fresh.sh --keep green over the shipped text — `RESULT: PASS — 210 quality
                    checks on a from-scratch schema (tables=58, migrations=7)` — with the three rows read off
                    the kept database: `11 array column(s) measured (6 text[], 5 jsonb holding arrays), each
                    answered: … merchants.tags = nothing-bounds-it … tenants.locales = column-default —
                    elements: collections.items 38/25, merchants.images 520/10, offerings.images 5534/10,
                    offerings.options 4409/3, merchants.tags 2428/100, tenants.locales 3/3 — offenders: none` /
                    `collections.items keysets=1 [note, subject_id, subject_type] over 38 element(s), …
                    reviews.photos keysets=0 [-] over 0 element(s) — offenders: none` /
                    `text[] column merchants.tags = 520 row(s), 2428 elements, 100 distinct, rarest on 2 row(s),
                    commonest on 520 — repetition holds … | below §71's row floor: api_keys.scopes (0 row(s)),
                    campaigns.channel (0 row(s)), eval_cases.tags (0 row(s)), external_principals.scopes
                    (0 row(s)), tenants.locales (1 row(s))`. Kept gate databases dropped when this unit closes;
                    the drifted `nexus` database and `nexus_funnel_probe` belong to other streams and were
                    never opened. No Java, migration or seeded value changed.
next              residue worth carrying: (a) the `column-default` comparison is a count match plus a presence
                    test against the DEFAULT text, not a set equality — swapping zh-HK for zh-TW at the same
                    count is caught only if it drops a declared element, and that is stated rather than papered
                    over; (b) whether the SEO grammar SHOULD carry a controlled facet list is another stream's
                    product decision, recorded here as an absence the gate now describes; (c) the census covers
                    text[] and jsonb because those are the only containers shipped — composite types (category
                    `C`) are absent by measurement, not by assumption, and would need their own element rule;
                    (d) `reviews.photos` empty on all 11000 rows is now a claimed state, so the first seed that
                    writes a photo path has to answer for it — and §109 is the reason nobody should. Standing
                    reports unchanged: `saved_searches.notify` read by nothing; `no_show` named once by a door
                    list with no reader; CommerceApiTest belongs to another stream; the split migration ledger in
                    `nexus_test` belongs to the infrastructure lane; the events subject seam (D70) waits on a
                    contract decision.
```

## 78. Four booleans claim a verification the schema cannot evidence, and two reach the user (2026-09-25)

§77 ended with a clean negative — no boolean in the schema is degenerate — so this unit asks the other question
about the same columns: four of them assert that something happened elsewhere, and the database is guarded so
that it cannot have. `reviews.verified_purchase` is true on 2456 of 11000 rows and `verified_reservation` on
1289 (300 rows carry both), while `orders`, `payments`, `reservations` and `carts` hold 0 rows each because D64's
fabrication guard demands it. The flag is also structurally untraceable: `reviews` has no non-boolean column
naming an order or a reservation — the only `%reservation%` column on the table is the flag itself.

```
measured          12 boolean columns, 9 in populated tables, none never-true and none always-true; the four
                    name-shaped claims are reviews.verified_purchase 2456/11000,
                    reviews.verified_reservation 1289/11000, merchants.ownership_verified 193/520,
                    users.marketing_opt_in 1/5 — 3745 flags over 3445 distinct reviews. Evidence: orders=0,
                    payments=0, reservations=0, carts=0. Served, not dormant: CatalogController.java:391-397
                    derives the consumer-facing `verified_visit` from the two flags and :441-442 publishes
                    verified_purchase_reviews / verified_reservation_reviews as merchant statistics;
                    AdminListRepository.java:126 carries both into the admin view. Two readings stay open —
                    demo decoration (§109's fake engagement) or a provenance marker rendered as a trust signal
                    (§19) — and this unit takes neither: the fix would be generate.py or the payload, both owned
                    by other streams. What the gate now says is that the badge cannot be traced, and that it must
                    stop being able to say so once tracing becomes possible.
new/changed       data/seed/quality.sql only, +175/-0. badge_cat (every boolean matching
                    verif|opt_in|consent|ownership: rows, flagged rows, and the word a key column would carry);
                    badge_answer (the hand list: evidence table or '-', state in never-resolvable |
                    no-evidence-table | resolved | unresolved, non-blank reason); badge_state (per answered flag:
                    rows in the named evidence table, and non-boolean columns of the flagged table carrying the
                    key word — excluding booleans is what stops verified_reservation counting as a path to
                    reservations); badge_live, a view that RECOMPUTES the implied state from those two numbers.
                    Two rows: the census and the answers named for each other both ways with a known state and a
                    table that still exists; and the answered state required to equal the recomputed one, so
                    `never-resolvable` holds only while evidence rows = 0 AND link columns = 0.
                    210 -> 212 checks.
plants            9 runs at three seams (before the censuses for DDL, between them for the answer list, after
                    both for the measured counts), every DDL plant reverted and re-counted. W0 212 green ·
                    B1 delete the purchase answer -> RA only, and RB stayed green because three remaining
                    never-resolvable answers still satisfy its non-vacuity term (recorded, not smoothed) ·
                    B2 state='probably-fine' -> RA **and** RB · B3 blank reason -> RA ·
                    B4 the purchase answer says 'resolved' -> RB · B5 evidence_rows 520 -> RB ·
                    B6 `ALTER TABLE reviews ADD COLUMN order_id uuid` -> RB (the badge is now a checkable claim)
                    · B7 `users.verified_identity boolean DEFAULT true` -> RA (a fifth flag, unanswered) ·
                    final 212 green with `link-shaped non-boolean columns on reviews=0` and
                    `users.verified_identity=0`. One false start is the unit's real finding about the gate: the
                    first version stored `implied` in badge_state and compared `state <> implied` — two of the
                    check's own columns — so no world could refute it and the plants came back green; recomputing
                    the state in badge_live is what made B4-B6 able to fail.
gates             scripts/db_gate_fresh.sh --keep green over the shipped text — `RESULT: PASS — 212 quality
                    checks on a from-scratch schema (tables=58, migrations=7)` — with both rows read off the kept
                    database: `4 verification-shaped boolean(s): reviews.verified_purchase true on 2456 of 11000,
                    evidence orders holds 0 row(s), 0 link column(s) -> never-resolvable | …
                    merchants.ownership_verified … evidence - … -> no-evidence-table | users.marketing_opt_in
                    true on 1 of 5 … — offenders: none` and `all 4 answer(s) agree with what the data supports
                    (never-resolvable/no-evidence-table): 3745 flagged rows carry a badge that cannot point at an
                    order or a reservation, and this row reddens if either becomes reachable`. Kept gate databases
                    dropped; `nexus`, `nexus_test` and `nexus_funnel_probe` were not opened. No Java, migration or
                    seeded value changed, so mvn -o test and e2e_fresh.sh stay out of scope.
next              residue: (a) the flag pattern is the set's definition, so `has_receipt` or
                    `trusted_reviewer` would be invisible to it — stated so the next reader widens it on purpose;
                    (b) row 2's non-vacuity term is per-state, not per-answer: B1 proved losing one answer leaves
                    the row green, so a future seed that empties `reviews` entirely would need the term tied to
                    the flagged count rather than to the answer count; (c) `ownership_verified`'s
                    `no-evidence-table` answer rests on the §5 reading that ownership is a status the
                    verification door moves — and those transitions are #17's unfinished work, not this row's;
                    (d) the open product question stays open and is filed as #56: either the badges stop being
                    served, or the demo stops stamping them, and §109 is why the second is the honest default.
                    Standing reports unchanged: `saved_searches.notify` read by nothing; `no_show` named once by
                    a door list with no reader; CommerceApiTest and the drifted `nexus` database belong to other
                    streams; the split migration ledger in `nexus_test` is the infrastructure lane's; the events
                    subject seam (D70) waits on a contract decision.
```

## 79. 76 numeric and timestamp columns counted: 24 cannot vary, and one varies with the load clock (2026-09-25)

§75, §81 and §82 enumerated strings, array elements and booleans. Numbers, dates and timestamps had never been
counted at all. On a from-scratch database there are 76 such columns (uuid excluded): 4 are NULL on every row,
20 hold a single value, and **none is corrupt** — the range and ordering rules all came back clean (no review
older than its edit, no fact expiring before observation, no merchant updated before creation, no negative price,
no over-booked slot). So this is not a bug hunt; it is the ledger of which columns cannot discriminate, and the
one whose value changes every time the seed runs.

```
measured          NULL everywhere: chunks.embedded_at (2118), moderation_cases.resolved_at (544),
                    permission_grants.expires_at (36), users.deleted_at (5) — no embedding recorded, no case
                    resolved, no grant expired (§43), no user deleted. Single value: 18 columns plus
                    offerings.min_party_size (1 across exactly the 804 bookable offerings) and
                    offerings.stock_updated_at (232 of 5534); most timestamps sit on the pinned base date
                    2026-09-22 11:00, others on deliberate backdates (tenants.created_at 2024-07-14,
                    user_identities.* 2026-06-14). facts.updated_at is the exception: 2026-09-25 10:39:53, the
                    LOAD instant, because V6 added it `NOT NULL DEFAULT now()` to satisfy the V1 set_updated_at
                    trigger that had been assigning a field facts did not have — its COMMENT promises "when this
                    claim was last restated", so a fresh demo reports all 5688 claims as restated at load time
                    and the shipped value differs between runs.
new/changed       data/seed/quality.sql only. spread_cat classifies every N/D/T column of a populated table
                    (all-null / constant / sparse-constant / varying) with rows, nulls, distinct values and the
                    value itself; spread_answer names the kind of each degenerate column
                    (never-written | all-open-queue | uniform-by-design | single-instant-pinned | history-date |
                    generation-clock) with a reason; spread_clock derives from the data which answered columns
                    really hold a value within ten minutes of now(). Two rows: answers and census named for each
                    other both ways, with a stale exemption refused; and the clock set equal, in both directions,
                    to the answers that claim it. 212 -> 214 checks.
plants            nine runs, three seams, W0 and final green at 214. PROVEN: C4 the census copy of
                    offerings.min_party_size given 2 distinct values -> row 1 refuses its uniform-by-design
                    answer · C6 facts.updated_at pinned while still answered generation-clock -> row 2 red, naming
                    the column and its value · C7 `ALTER TABLE merchants ADD COLUMN dormant_years smallint`
                    (NULL everywhere, unanswered) -> row 1 red. ALSO PROVEN, by accident: an earlier C4 tried
                    `UPDATE offerings SET min_party_size = 2`, and V1:961-970's set_updated_at BEFORE UPDATE
                    trigger moved offerings.updated_at with it — the census saw that audited column start varying
                    and refused its single-instant-pinned answer. A plant that reaches a column under audit through
                    a trigger cannot be undone, so the plants mutate the census copy and never the rows.
PROVEN TOO, on a freshly built database with green 214-check baselines either side (W0 and W9 emitted=214
                    red=0): P1 delete an answer -> row 1 red, printing `23 answered` against 24 degenerate
                    columns · P2 kind 'immutable' -> row 1 red · P3 blank reason -> row 1 red ·
                    P4 merchants.updated_at given a load-time value in the census -> row 2 red with
                    `2 column(s) hold a single value within ten minutes of now(): facts.updated_at … (3 min
                    old), merchants.updated_at … (0 min old)`. The first two attempts at those four printed
                    `checks emitted: 0` — a mutation injected before the hand list existed, and a heredoc
                    escape turning an escaped newline into a real one — recorded at the time as INVALID rather
                    than as a pass, and now closed: the driver reads the gate file directly and injects after
                    the answer table is populated.
gates             scripts/db_gate_fresh.sh --keep green over the shipped text — `RESULT: PASS — 214 quality
                    checks on a from-scratch schema (tables=58, migrations=7)` — with the census read off the kept
                    database: 76 columns counted, `53 varying / 18 constant / 2 constant-with-nulls / 4 NULL
                    everywhere; 24 answered`, and the clock row printing `1 column(s) hold a single value within
                    ten minutes of now(): facts.updated_at = … ; pinned base date for comparison: 2026-09-22 from
                    availability_slots over 21 days`. `nexus`, `nexus_test` and `nexus_funnel_probe` untouched.
next              residue: (a) finish the four missing witnesses above before this row is called proven; (b) the
                    clock term compares a text value to now(), so a column stamped more than ten minutes before
                    load escapes it — the window is a choice and is written here, not hidden in a constant; (c)
                    `facts.updated_at` staying load-time is a decision about the seed and the README's pinned-date
                    claim, and it belongs to whoever owns generate.py — this unit states the drift and takes it
                    no further; (d) `permission_grants.expires_at` NULL everywhere re-lands §43's already-recorded
                    "a claim nobody ever expires" from a second direction, which is worth reading as corroboration
                    rather than as a new finding. Standing reports unchanged: `saved_searches.notify` read by
                    nothing; `no_show` named once by a door list with no reader; CommerceApiTest and the drifted
                    `nexus` database belong to other streams; the split migration ledger in `nexus_test` is the
                    infrastructure lane's; the events subject seam (D70) waits on a contract decision.
```

## 81. Eleven jsonb keys the build reads; ten resolve to nothing in the shipped payloads (2026-09-25)

The previous five units enumerated what the seed writes. This one asks what the build READS out of the jsonb
payloads, and finds the two sides disagree — including in a clause that decides whether a collection is
publishable.

```
measured          collections.seo ? generated_by 0 of 4 rows; merchants.seo ? generated_by 0 of 520; the same
                    key on seo_pages.data and seo_pages.jsonld, orders.metadata ? session_id, referrals.reward ?
                    amount and ? currency — all four on tables D64 keeps EMPTY; offerings.attributes ?
                    import_job 0 of 5534, documents.metadata 0 of 1040, chunks.metadata 0 of 2118; the only
                    reachable read is tenants.config ? currency_default, 1 of 1. Two are load-bearing:
                    CollectionsRepository.java:23 documents publishability as seo->>'generated_by' carrying a real
                    provenance token and :68 encodes it as an IN list, so on shipped data the test is always false
                    and the other branch always decides; MerchantImportRepository.java:37 selects drafts by
                    attributes->>'import_job' is not null and matches nothing, so the import lane reports no
                    imports. Five unreachable for a rule-bound reason (§109 keeps their tables empty), five dead
                    readers on populated tables, one reachable.
new/changed       data/seed/quality.sql only, +161/-0. read_cat (rows shipped, rows carrying the key, per read) x
                    read_answer (kind in reachable | dead-reader | empty-by-guard, the site as file:line, a
                    non-blank reason); one row refusing an unanswered read, an answered column the catalogue
                    dropped, a reachability change in either direction, an unknown kind, and a blank reason or
                    site. 214 -> 215 checks.
plants            five, all on a freshly built database, all reddening the row: delete an answer (histogram prints
                    dead-reader=4) · kind 'unused' (prints unused=1) · collections.seo given 7 carrying rows
                    (counts move to 9 resolve to nothing, 2 carry a key) · orders given 12 rows (the
                    empty-by-guard term) · a blanked reason. My own bug found first: a string_agg over a GROUP BY
                    count inside a scalar subquery is a nested aggregate and aborts the file under
                    ON_ERROR_STOP=1 — grouped counts now come from a subselect, and an aborted run is reported as
                    INVALID rather than counted as green.
gates             scripts/db_gate_fresh.sh --keep over the shipped text: `RESULT: PASS — 215 quality checks on a
                    from-scratch schema (tables=58, migrations=7)`, and the gate file re-run green after the
                    plants. Kept database dropped afterwards (0 nexus_gate* remain); `nexus`, `nexus_test` and
                    `nexus_funnel_probe` never opened. No Java, migration or seeded value changed.
next              residue: (a) the read list is a transcription of `col->>'key'` occurrences — a read made through
                    `Json.str(row.get(...))` or a Java-side constant is invisible to it, so widening the grep is
                    owed to this row; (b) if the import feature is meant to seed documents rather than offerings,
                    then it is the seed that is short, not the selector; (c) the decision itself — stamp a
                    provenance token, or change the §8 test — belongs to #59 and that door's owner, and is
                    reported here with counts and sites rather than taken. Nine units now sit on the branch
                    (D77–D84): gate 199 -> 215 checks.
```

## 82. The read census gets a second reader, and it refutes six of D84's nine lines (2026-09-26)

§81's own residue said its read list was a transcription of one grep, and that widening the grep was owed to
the row. The widening is a scanner of a different principle — it parses Java text blocks for the SQL form, and
it parses map accessors for keys read out of a jsonb object — and it runs inside the gate rather than beside it.
It found eleven reads the SQL grep could not see, and it refuted six of the nine lines D84 had carried.

```
measured          scanner over services/platform: 174 files, 26 read sites, 19 distinct (column, key) pairs,
                    3 of them resolved to a table by the FROM/JOIN alias in the same file. The census behind
                    it now answers 17 reads and the from-scratch database reads them as
                    `17 read(s) measured against the shipped payloads: 15 resolve to nothing, 2 carry a key;
                    dead-reader=12, empty-by-guard=3, never-read=1, reachable=1`. The two that resolve:
                    collections.seo ? noindex on 4 of 4, tenants.config ? currency_default on 1 of 1.
                    Newly visible (accessor reads, invisible to a `col->>'key'` grep): collections.seo
                    reviewed_by_human / noindex / curated_by / model / city / category / cover (7 keys,
                    CollectionsController.java:217-313, `reviewed_by_human` being the §27 human-review gate)
                    and documents.metadata extractor / degraded / note / proposals (ImportService.java:193-197,
                    one of them through getOrDefault).
refuted           five answers named no read site anywhere in the scanned source — seo_pages.data and
                    seo_pages.jsonld ? generated_by, and documents.metadata and chunks.metadata ? import_job
                    were one clause copied sideways onto sibling jsonb columns ("the doc lane", "the chunk
                    lane"); merchants.seo ? generated_by named a real clause over the wrong table (the FROM at
                    CollectionsRepository.java:52 is `from collections c`); and tenants.config ?
                    currency_default was called `reachable` with a write site in the read column, for a key
                    D46 had already reported unread. The first four are gone from the census; the last stays
                    under a new mirror kind, `never-read` — a key that ships and no read names, refused by the
                    gate row if it stops shipping and by step 7 if a read for it appears.
new/changed       scripts/check_jsonb_reads.mjs (new, 304 lines; four fatal blocks — UNDECLARED, WRONG TABLE,
                    CALLED NEVER-READ IS READ, NO KIND — and one report-only block, an answer the scan finds no
                    read for, because that is either a stale answer or one of its declared blind spots).
                    scripts/db_gate_fresh.sh +12/-2: step 7, and it dies rather than skipping when node is
                    absent; the step labels are now all /7 (five of them had been left saying /6).
                    data/seed/quality.sql +125/-28: the census list rebuilt to 17 triples with the site of each
                    read verified by hand, the fourth kind accepted, and the never-read term added.
                    215 checks — D85 adds a step and corrects what a row asserted, it adds no row.
plants            eight. Five on the scanner, each restoring the file byte-for-byte and re-checking its sha:
                    drop collections.seo.city -> UNDECLARED naming the site · put merchants.seo.generated_by
                    back -> WRONG TABLE "reads this at collections, not merchants" · re-kind noindex as
                    never-read -> CALLED NEVER-READ, IS READ · orphan a list entry from its answer -> NO KIND
                    (that plant also trips UNDECLARED and the report list, so it proves the block fires, not
                    that it fires alone) · a clean run prints exit 0. Three on the gate row, on the kept
                    database with the payloads snapshotted into a scratch schema and replayed afterwards:
                    strip noindex from every collection -> `16 resolve to nothing, 1 carry a key` · set
                    reviewed_by_human on all four -> `14 resolve to nothing, 3 carry` · drop currency_default
                    -> the never-read term. All three returned the payloads to `15 / 2`.
gates             scripts/db_gate_fresh.sh over the shipped text: `RESULT: PASS — 215 quality checks on a
                    from-scratch schema (tables=58, migrations=7), plus the seed truncate shown clearing an
                    empty stranger and refusing one that holds rows, and the build's jsonb reads reconciled
                    against that list of answered keys`, step 7 printing `declared in quality.sql 17 triple(s)`
                    and `tables resolved from FROM 3 of 19 read pair(s)`; exit 0, and the run's own database was
                    dropped (`nexus`, `nexus_test`, `nexus_funnel_probe` never opened). `mvn -o test` not re-run:
                    no Java changed in this unit.
next              residue: (a) accessor reads are matched on (column, key) alone, so an answer covers that key
                    on any table — merchants.seo carrying no provenance token on 520 rows is a true measurement
                    that now has no owner row, and it becomes census-able when the scan resolves accessors to
                    tables; (b) a key reached through a helper, named by a constant, or built in another file is
                    still invisible, which the script prints on every run instead of implying; (c) a witness
                    that UPDATEs jsonb moves `updated_at` through the set_updated_at() trigger, so a restore can
                    leave another row red — the shipped state is the one the gate re-establishes, not the one
                    the probe leaves behind; (d) the product question from §81 (stamp the token, or change the
                    publishability test) is still #59's and still reported rather than taken. Standing reports
                    unchanged: another lane's working-tree §36-§37 describe this script at an earlier revision
                    and its `.github/workflows/ci.yml` runs it hard-fail — both uncommitted and not this
                    stream's to correct; CommerceApiTest and the drifted `nexus` database belong to other
                    streams; the events subject seam (D70) waits on a contract decision.
```

## 83. 22,592 payload rows sit in jsonb documents a key read cannot reach; one column carries two encodings (2026-09-26)

D84/D85 census which jsonb *keys* the build names. This counts the plane below keys: the document type each payload
column actually holds, because against an array — or against a string whose text is JSON — a key read returns
nothing, and a `?` test says `false` exactly as it does for a genuinely absent key.

```
measured          From-scratch schema: 22 jsonb columns carry a payload — 45,686 object rows, 22,592 array rows,
                    0 string rows, out of 68,278 payload rows. So key navigation reaches 45,686 of them: a third of
                    this database's jsonb is unreachable by the reads D84/D85 censused. All five unreachable
                    columns are lists: collections.items 4, merchants.images 520, offerings.images 5,534,
                    offerings.options 5,534 (2,936 of them []), reviews.photos 11,000 (all []).
                    Live demo database, where the agent and event writers have run (read-only): 62 jsonb columns,
                    32 holding payloads — 43,516 object, 22,592 array, 188 string, and str_json = 188, i.e. every
                    string payload is JSON text. agent_runs.plan->>'steps' NULL on 40 of 40, re-parsing reaches 38
                    (2 hold {}); agent_runs.tool_calls->'0' NULL on 40 of 40, re-parse: 38 one-element arrays, 2
                    empty; events.properties->>'query' NULL on 35 of 35, re-parse reaches 34. Two writers, two
                    encodings, one column: runs.py:144,:158 binds json.dumps text into $10::jsonb over asyncpg
                    (pool.py:222), which quotes a str again — all 34 string rows are named search, that call's
                    default — while EventRepository.java:39 casts, which parses. The 35th row is an object named
                    view; its name does not prove which lane sent it, and the file says that rather than guessing.
                    The finding this unit did not plan for: double-encoding a whole populated column (all four
                    collections.items payloads) does not redden the new row, it ABORTS quality.sql — the guide-item
                    check's `JOIN jsonb_array_elements(c.items)` ~2,400 lines earlier raises
                    `cannot extract elements from a scalar` and ON_ERROR_STOP=1 kills the file before any check
                    prints. The Java readers of the same payload fall through to an empty list (Json.java:207-233).
new/changed       data/seed/quality.sql only, +169/-0. shape_cat (per jsonb column: rows, non-null, one FILTER per
                    jsonb_typeof, plus the JSON-text proxy) filled by a $d86a$ loop over information_schema;
                    shape_kind VIEW deriving object-only | array-only | double-encoded | mixed-* | scalar-* from
                    that measurement, so no answer chooses its own kind; shape_answer with the five list columns,
                    each naming where the shape is consumed and why it is not a bug. One qc row, five refusal terms:
                    unanswered shape, answer for a column with no such payload here, kind the data contradicts,
                    unknown kind, blank reason or site. 215 -> 216 checks.
plants            seven, replayed against the shipped text on a freshly built database after the site corrections
                    below (W0 green, W1-W7 red, W8 green): drop an answer -> `reviews.photos ships array-only on
                    11000 row(s) and nobody answers for it`. Re-kind merchants.images -> `answered double-encoded while the data
                    now says array-only (0 object, 520 array, 0 string of 520 payload row(s))`. One reviews.photos
                    payload becomes an object -> `mixed-object-and-array (1 object, 10999 array …)`, restored
                    exactly (0 object rows before and after; reviews has no set_updated_at trigger, so no clock
                    residue). One inserted double-encoded events.properties row -> `ships double-encoded on 1 row(s)
                    and nobody answers for it`, histogram to array-only=5 + double-encoded=1, and six guard rows
                    reddening with it because events is a guard-empty table — all seven back to green after the
                    delete. Then the three offender arms separately: blank reason -> `gives no reason for why the
                    shape is not a bug`; blank site -> `gives no site for where the shape is consumed`; kind
                    'unused' -> both `the data now says array-only` and `names kind 'unused', which is not one of
                    the seven this file derives`.
mistakes          four, all mine, none found by the gate. (1) The first offender list merged "kind not in the seven"
                    with "reason/site blank", so a blank reason printed an accusation against a valid kind — split
                    into three arms, each witnessed. (2) The witness driver passed `-f` a host path into psql
                    running inside the container: five runs reported `No such file or directory` and the classifier
                    called them INVALID, not green. (3) A remembered header number ("3-element array in every
                    tool_calls string") was wrong: 38 one-element, 2 empty — re-measured before committing, the same
                    failure D78 wrote about its recalled 75. (4) Three of the five answer SITES were false while the
                    row was green: MerchantRepository.java:307 is the merchants.seo line (images is :306),
                    offerings.options was answered with OrderRepository.java whose `options` belongs to
                    order_items (D82's "a column name is not the target"), and collections.items had a filename with
                    no line. All five now name the `Json.jsonArray` accessor that consumes the array plus its whole-
                    column SELECT — which is also why they are not bugs.
gates             scripts/db_gate_fresh.sh over the shipped text: `RESULT: PASS — 216 quality checks on a
                    from-scratch schema (tables=58, migrations=7)`, all seven steps green including step 7's read
                    reconciliation. Kept gate databases dropped afterwards; the live databases were opened
                    read-only, to measure the string arm. No Java, migration or seeded value changed.
next              reported, not edited: whether runs.py should stop double-encoding is the AI lane's call (task
                    #62), and whether a CHECK should pin one encoding for events.properties is a schema decision
                    that has to reckon with two live writers. Residue this row owns: (a) the derivation is per
                    COLUMN, so the 34/1 split inside events.properties is visible in this entry and not in a gate
                    row — a per-(column, type) census with row counts is the widening that would let an answer say
                    "one writer of two"; (b) the `site` column is checked only for being non-blank, and mistake (4)
                    is exactly what that costs — scripts/check_jsonb_reads.mjs already parses these accessors, so
                    feeding shape_answer's sites through it is the next unit. Also stated so it is not mistaken for
                    a regression: quality.sql is green only on a recently loaded database — D83's generation-clock
                    row reddens once facts.updated_at is more than ten minutes old, so re-running this file against
                    a kept gate DB later is not the official run.

## 84. A `site` is an assertion: 31 citations read back out of the source, seven ways of being wrong (2026-09-26)

§83's residue (b) was two sentences: the gate refused a blank `site` and nothing more, and the row that refused it
was a row whose own `site` column had shipped three false citations while green. This unit opens the files.
`scripts/check_jsonb_reads.mjs` — step 7's second reader, the one that already censuses the build's jsonb reads —
now parses both answer tables out of `data/seed/quality.sql`, resolves every citation to a shipped source line,
and refuses seven ways of being wrong about it.

```
measured          Before the rule was written, from the shipped text: 22 answer rows (17 read_answer +
                    5 shape_answer) carry 31 citation tokens, which expand to 41 line spans in 12 files; 38
                    distinct source lines are read back per run. The site index is 479 files (171 .java, 66 .py,
                    242 .ts/.tsx/.mjs/.cjs/.sql/.sh) under a hand vendor exclusion — 10 names then, 14 after D88;
                    the read census walks only
                    its two roots, 174 java/py files, and finds 26 read sites over 19 distinct (column, key)
                    pairs, of which 3 have a table resolved from a FROM/JOIN alias. Six citation grammars, not one:
                    `File.java:NN`, `File.java:NN,:NN,:NN`, `merchant/File.java:NN` (a directory prefix resolved
                    by path suffix), `commerce/File.java:NN-NN` (a range), bare `:NN` continuing the previous file,
                    and
                    `generate.py` naming a file with no line. A parser written for the first shape would have
                    checked a fraction of the census and printed a green number, so the run prints the row count
                    it parsed and compares it against a second parse of the same block (17 and 17, or it says so).
                    The one rule that had to be measured rather than guessed: `__init__.py` is the ONLY basename
                    those 237 java/py files hold twice (8 copies), so the ambiguous-name arm is unreachable by
                    the shipped text and is witnessed by a plant and labelled as such. Widening that sentence to
                    the whole 479-file index: 14 basenames are held by more than one file — `page.tsx` by 31 of
                    them — so the arm is far from unreachable in general, and no shipped answer happens to cite one.
new/changed       scripts/check_jsonb_reads.mjs — stripSqlComments (literal-aware, `''` aware), valuesRows
                    (paren/quote-aware row and cell split, literal concatenation, and a terminator rule that
                    refuses a `;` where no row is closing), CITE_RE/citations (bare `:NN` inherits the last
                    file), sourceIndex over the repo minus the vendor dirs, checkSites with the seven arms and
                    an `in site`/`in why` field name in every message. data/seed/quality.sql — five shape_answer
                    sites gained their writer line (`generate.py:292` and `:1342` for collections.items, `:251`
                    merchants.images, `:266` both offerings arrays, `:274` reviews.photos) plus a header comment
                    saying step 7 reads every `File.java:NNN` back and what it refuses. scripts/db_gate_fresh.sh —
                    step 7's label and the RESULT footer now name the site census; the "missed eleven reads"
                    claim in that comment is gone because it was never measured. No Java, migration or seeded
                    value changed; the gate's check count stays 216.
plants            fourteen cases, replayed over the final shipped text: P0 baseline green, P1-P12 twelve plants,
                    P13 green again — 14/14 MATCH, and the tracked quality.sql sha256 (9deda9b3…) re-verified
                    after every run because the plants write a copy and pass it with `--quality=`. The three
                    mistakes §83 shipped are replayed as three plants, each caught by a different arm:
                    images `:306 -> :307` (rule 4, the line reads merchants.seo), offerings.options pointed at
                    commerce/OrderRepository.java (rule 7 — `options` really is on those lines, as
                    order_items.options, so only table attribution can see it), and a filename with no line
                    (rule 5). The rest: rule 1 CatalogRepositori.java, rule 2 with an `__init__.py` cite (the index holds 8 of them), rule 3
                    `:99999` past EOF and `:84-78` backwards — the latter two in the `why` column, which is
                    where they were hiding, see mistake (3); rule 6 quoting "photos" at a line that reads
                    "items"; the non-vacuity guard with an answer row deleted; and P11/P12 on the parser itself —
                    P11 (a `;` inside a `-- comment` mid-list) is required to stay GREEN, P12 (a bare `;` where
                    no row closes) must throw. Each red is attributed to the named arm whose message the driver
                    matched, not to an exit code.
mistakes          six, all mine, one of them found by my own guard. (1) The measurement script I used to write
                    the rules silently lost the 17th read_answer row: a `;` inside a `-- comment` ended the
                    VALUES list for a comment-blind scanner, so the census it printed was smaller and greener than
                    the file. That hazard became stripSqlComments and plant P11. (2) The shipped parser then had
                    the same class of bug from the other side — both quote loops advanced twice after a closing
                    quote, skipping the last row's `)`, so **zero** rows parsed and the sites went unchecked while
                    the read census printed green. What caught it was the non-vacuity guard written for exactly
                    this: `this script parsed 0 read_answer rows while its read census parsed 17 read_cat triples
                    — the two are meant to agree`. (3) P6/P7 came back GREEN on the first run: the range and EOF
                    checks sat behind the `content` guard, so a `why` citation's line numbers were never
                    validated and P7's range — the shipped `commerce/OrderRepository.java` pair stretched to line
                    99999 of a file that has 145 — passed. Bounds moved above the guard — a
                    backwards range is false wherever it is written. (4) The new rule reddened five shipped rows
                    at once, all of them `generate.py;` with no line; the answers were under-specified, so the
                    claims changed and the rule did not (the D64 posture, arrived at in the citation column).
                    (5) A remembered count in this unit's own task title said 25 file:line pairs; the shipped
                    text has 31 tokens over 41 spans. (6) The rule-1 message printed the whole field's citation
                    list in a parenthetical, which read as if every file named there was missing; it now names
                    only the one file and the index size it searched.
gates             scripts/db_gate_fresh.sh over the shipped text: `RESULT: PASS — 216 quality checks on a
                    from-scratch schema (tables=58, migrations=7)`, all seven steps green, step 7 printing the
                    site census and `every cited line names the table, column or key its row is about`. `node
                    scripts/check_jsonb_reads.mjs` alone exits 0 on the shipped tree. Same caveat as §83: this is
                    green on a freshly loaded database — D83's generation-clock row reddens once facts.updated_at
                    is more than ten minutes old, so a kept gate DB is never the official run.
next              reported to their lanes, not edited: the AI service binds json.dumps(…) into eight $n::jsonb
                    placeholders in apps/ai/nexus_ai/api/runs.py (:118, :120, :121, :158, :159, :182, :207, :208)
                    through asyncpg, which quotes a str again — 188 string-valued jsonb rows on the live demo
                    database, 34 of them events.properties (task #62); and the web lane declares Guide.body_blocks
                    required (apps/web/src/lib/types.ts:266), maps over it at growth-view.tsx:72, synthesises it
                    in lib/mock/index.ts:740, while the string body_blocks does not occur anywhere in
                    services/platform/src/main/java — a live §8 guide cannot satisfy the type its reader assumes.
                    Residue this row owns: (a) "the cited line mentions the row's table, column or key" is a
                    disjunction over three identifiers, so a citation to the right line for the wrong reason
                    passes and no textual check can see that; (b) rule 7 has no teeth against generate.py, which
                    names every table in the dataset — writer citations are checked for line content only;
                    (c) `why` is checked for structure and deliberately not for content, because a reason may
                    name neighbouring code on purpose (offerings.options cites order_items.options precisely to
                    say it is a different column); (d) the ledger's own prose citations are outside this
                    scanner, which reads `File.ext:NNN` but not `EventsController:63` or `V1:574`; a checker for
                    the prose plane is owed to this row — and the sentence that used to stand here claimed that
                    plane had been measured (114 tokens, 71 targets, 33 files, all resolving). It had not. The
                    count was second-hand and D88's checker, run over the same text, found 162 citation-shaped
                    tokens in 48 files with 13 of them false; (e) the vendor exclusion was a 10-name hand list
                    duplicated in two scripts, and a new vendored directory silently joins the source index.
```


## 85. The ledgers carry 162 source citations, 13 were false, and step 8 now opens every one of them (2026-09-26)

§84's residue (d) owed a checker for the prose plane and, in the sentence before it, published a count of that
plane nobody had taken. `scripts/check_ledger_citations.mjs` is gate step 8: it reads `docs/DECISIONS.md` and
`docs/STATUS.md`, resolves every citation-shaped token the way D87 resolves a `site`, and the first run contradicted
the number above it. 13 of the 162 committed citations do not resolve, and all 13 were this lane's own sentences.

```
measured          From the committed text (e028297) before any rule was softened: 256 `name:number` tokens, 162
                    citation-shaped, 127 bare `:NN` continuations, 48 distinct files resolved. Offenders: 13 —
                    nine FILE NOT FOUND, two PAST EOF, two AMBIGUOUS. BACKWARDS and ZERO have no false cite to
                    find in the shipped text, so those arms are plant-witnessed and labelled here as such.
                    Eight of the nine missing are the same four invented grammar tokens (`File.java` at 12,
                    `File.java` at 217 with continuations 289 and 294, `merchant/File.java` at 306, `commerce/File.java` over 78-84) written into
                    both ledgers to stand for "any file"; two are D87 quoting its own plant as a site; one is
                    D86's elided `services/platform/.../growth/EventRepository.java` at 39; the ambiguities are
                    `.gitignore` at 21 (root AND packages/sdk) and `__init__.py` at line 1 (8 copies). 94 of the 256 tokens
                    are not citations: host:port, `ENV_NAME:10`, `§NN`, `DNN`, and prose such as `page 12:34`.
                    The ledger index is 569 files (171 .java, 114 .ts, 75 .tsx, 66 .py, 143 others) against
                    D87's 481 source-only — and 481, not the 479 §84 printed, because two source files arrived in
                    another lane since; a census number in a ledger is a photograph. The 10-name vendor list grew
                    to 14 because `.pytest_cache` contributes two `README.md` and two `.gitignore` to a ledger
                    index, both basenames already held elsewhere, so a `README.md:NN` cite reads as ambiguous
                    across a tool cache.
new/changed       scripts/check_ledger_citations.mjs (new) — resolve(): path by suffix, bare name by basename,
                    `V1` by migration, `Outer.Nested` by outer file, `./name` as root-relative; isCitation():
                    HOST/ENV/SECTION/FILE_SUFFIX/CLASS_NAME classifier over the token before the colon;
                    census(): tokens, spans, continuations and the section a claim sits in, so an offender is
                    attributed to the entry that wrote it; four whole-census guards that throw rather than print
                    green (index under 100 files, zero `## ` headings, zero citation-shaped tokens, citations
                    that resolved to no file at all); modes HEAD-strict (default) / --worktree / --report /
                    --verbose / --text=<file>. scripts/source_index.mjs (new) — VENDOR_DIRS, SOURCE_EXT and
                    walkFiles, the one list both scanners walk. scripts/check_jsonb_reads.mjs — its local index
                    and vendor list deleted and imported from the shared module; every other number unchanged.
                    scripts/db_gate_fresh.sh — 7 steps to 8; step 8 runs --worktree, because the other seven read
                    the tree they stand in and a green run must certify the text about to be committed, not the
                    text before it. The cost — another lane's unwritten paragraph can redden this lane's gate —
                    is taken from a measurement (that tree, with three lanes' uncommitted STATUS sections, is 151
                    citations and 0 offenders) and printed in the script's own LIMITS. docs/DECISIONS.md and
                    docs/STATUS.md — the 13 claims corrected in the claims, not the rule: `File.java:NN` for the
                    grammar illustrations, the plant named as a plant, the elided path spelled out,
                    `./.gitignore:21`, `__init__.py` with its copy count; and D87's limits paragraph now carries
                    the retraction of "114 mention tokens, 71 targets, 33 files, all resolving" as its own
                    paragraph instead of quietly editing it out.
plants            15 cases over a --text= copy; the tracked ledgers' sha256s re-verified after every one, since
                    this is the first unit whose plants aim at those two files. P0 baseline green; P1/P2 missing
                    by name and by path; P3/P4 ambiguous (8 copies, 2 copies); P5 the root-relative form that
                    fixes P4, required GREEN; P6 past EOF; P7 backwards range; P8 line 0; N1 non-citations; N2
                    the four accepted shapes (path, extensionless stem, `V1:574`, `MeController.FavoriteBody:59`);
                    N3 a `:99999` with no file in front of it, GREEN, which is the EOF arm stating its own width;
                    N4 a real line cited for the wrong reason, GREEN, which is limit (1) made visible; G1/G2 the
                    two whole-census guards. 15/15 MATCH. G1/G2 first came back green because appending one
                    section to a 5,087-line ledger cannot reach a guard that counts the whole census — so those
                    two plants replace the file. D87's 14-case matrix re-run over the refactored scanner: 14/14
                    MATCH, tracked quality.sql still 9deda9b3a845bb01.
mistakes          (1) Publishing a count that was never taken: D87's limits paragraph asserted the prose plane
                    measured 114/71/33 with three resolving-failures admitted, in the voice of arithmetic, and §84
                    repeated it. None of it had been derived. The real numbers are 162 tokens in 48 files, 13
                    false. What caught it was a checker outside the prose, not a closer reading of it, and the
                    unit that found it is the unit whose own limits paragraph carried the error.
                  (2) Treating a placeholder as a claim in the wrong direction: writing grammar illustrations as
                    `File.java` at 12 made prose that looks like evidence and is none. A checker cannot tell the two
                    apart, and neither can a reader; `:NN` says "any number" without pretending to be a cite.
                  (3) An ellipsis inside a path is not a path. `services/platform/.../growth/X.java` at 39 was
                    written to save a line break and read as a citation to a file that does not exist; the full
                    path fits, so the abbreviation cost nothing.
                  (4) A bare name can be a claim about the wrong file: `.gitignore` at 21 was true of the root and
                    false of `packages/sdk`, and nothing in the sentence said which. The root-relative `./` form
                    now carries that, and an ambiguous cite is refused rather than guessed at.
                  (5) A comment that explained itself: both new scripts said the vendor list had grown because
                    `PermissionService:40` resolved to a `.class` under a build directory. Re-deriving it: all 25
                    files in `.tmp-out` are `.class`, `.class` matches neither accept predicate, and `resolve()`
                    looks the stem up as `PermissionService.java` and finds one — so that sentence described an
                    event that cannot occur here, and was copied along as the reason for a change whose real
                    reason was two `README.md` copies in `.pytest_cache`. A justification is a claim too, and it
                    is the kind nobody re-runs.
                  (6) A row reporting a false cite commits one. The paragraph in DECISIONS that lists the nine
                    placeholder cites was itself red on them — fed to the checker with `--text=` it reported 8
                    offenders there and 10 in this section's draft, every one a quotation — because the grammar
                    is context-free: `name:digits` means "this points at a file" whether the sentence asserts it
                    or exhibits it as a mistake. The row was rewritten to say "`File.java` at 12" instead, which
                    keeps the file name, the line and the shape and moves the digits off the colon. No exemption
                    marker was added: a way to tell the checker to skip a token is a way to make it not look.
                  (7) A probe can fail in a way that reads like a finding: the overlap probe below reported 143
                    citations pointing at line 0, which is a number no file has. The cause was a character
                    class written `[,-:]` — not the two characters `,` and `:` but the RANGE between them,
                    which swallows every digit, so the split returned empty strings and `Number('')` is 0. The
                    shipped checker splits on `[:,]` and was never affected. The tell was the impossible
                    number, and it is the same tell that made a line-0 arm worth writing in the first place.
gates             gates             Two official 8-step runs, one red and one green, over a quality.sql that did not change
                    between them — the pair is the finding, and this section does not quietly keep only the
                    green one. The first run reached step 5 and stopped: 215 of 216 quality rows passed on a
                    from-scratch schema (tables=58,
                    migrations=7) and the generation-clock row D83 wrote failed, which aborts steps 6 to 8.
                    The second run, 25 minutes later over a tree unchanged in everything steps 1 to 5 read,
                    printed RESULT: PASS with 216 checks and ran steps 6, 7 and 8 — step 8 refusing nothing.
                    Nothing was fixed in between; what changed is how long the host took between the load and
                    the gate, which is item (e) below: that row selects on `abs(val - now()) < 600` seconds and
                    so measures the machine, not the seed. A row whose verdict depends on the wall clock is
                    retracted here as a gate and left standing as a finding. This unit's own steps were
                    certified by running their scripts over the shipped text: step 7 unchanged after the
                    shared-index refactor (14/14 witness cases MATCH, quality.sql still sha 9deda9b3a845bb01,
                    22 rows over 31 tokens, 41 spans in 12 files), step 8 refusing 0 offenders both over the
                    working tree (157 citation-shaped tokens there) and over the committed pair in HEAD — and
                    each new ledger section measured on its own text at 0 offenders. `bash -n` on the gate
                    script, `node --check` on both census scripts.
next              (a) the wrong-for-the-wrong-reason arm, sized by a throwaway probe during this unit — the
                    probe is not shipped, so these are a photograph the next run has to retake. Of the 162
                    citation-shaped tokens at HEAD: 41 have an identifier from their own sentence on the line
                    they point at, 102 do not, 8 sentences offer no identifier to compare against, 11 do not
                    resolve. So the arm is NOT buildable from prose-keyword overlap: two thirds of what it
                    would name are true cites — `EventsController` at 63 lands on
                    `Set.of("user", "merchant_user", "agent", "system", "anonymous")`, which is exactly what
                    the sentence claims, and the class name is simply not on that line. A rule that reddens
                    102 of 162 is noise wearing a gate; either the signal changes (a token the sentence
                    backticks about a column, not about a file) or the arm stays unwritten.
                  (b) the scope is two ledgers, and that is a
                    measurement: the tree's other 32 `.md` files carry 61 `name:number` tokens and none of them is
                    file-shaped, so nothing is lost there today — but 36 `file.ext:NN` cites sit on 30 comment
                    lines in source files (34 of them in quality.sql's own `--` notes beside the answers D87
                    checks), and D87 strips comments before parsing on purpose, so the comment plane is read by
                    neither row. Widening past `docs/` means a third reader, not a wider regex, and `docs/**` is
                    owned by other lanes anyway.
                  (c) the vendor list stays hand-written: one place to be wrong instead of two, still a place.
                  (e) THE FRESH-DATABASE GATE IS WALL-CLOCK DEPENDENT, and this unit's official run is the first
                    to show it: step 5 reddened on "the columns stamped from the generation clock are exactly
                    the ones answered so". `spread_clock` keeps a degenerate timestamp column when
                    `abs(extract(epoch FROM (val::timestamptz - now()))) < 600`, so the set it derives depends
                    on how long the machine in front of it has taken since the stamps were written — the row
                    asserts an equality between that derived set and the one column answered
                    `generation-clock` (`facts.updated_at`, and the row's first conjunct is that the derived
                    set is non-empty), and a slow host empties the derived set, not the data.
                    Nothing about the repository changed between the green run D83 shipped and this red one;
                    the elapsed time between the steps did. A probe run with the database left in place is what
                    names the columns and their deltas; the fix is to anchor the window on an instant the seed
                    itself carries instead of on `now()`, so the row answers the same question an hour later.
                    Until then this gate can go red with nothing wrong in the tree, which is the one kind of
                    red that teaches nothing.
                  (d) a census number quoted from an earlier run drifts under a live tree — §84's 479 is 481
                    today; the fix is a re-run, not a smaller claim. Carried over and untouched: §78(a),
                    §76(a)/D80, §78(b), §77(a), §77(c), §82(a), D86(a), and the four open reports (#58, #62,
                    #64, #44).
```
