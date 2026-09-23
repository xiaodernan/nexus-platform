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
