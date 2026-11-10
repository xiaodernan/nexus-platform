# NEXUS Atlas — the whole repository on one page

**Status:** a map, not a claim. Every path written in backticks on this page is checked by
`scripts/check_atlas.mjs`; every reader, document and cloud smoke the repository ships must appear
here or that gate reddens. That second half is deliberate: an atlas nobody updates is worse than no
atlas, so adding a reader without adding its row is a visible failure, not silent drift.

For *what exists today*, see `README.md`. For the cloud plane's one page, see `docs/CLOUD.md`. For
the unit-by-unit ledger, see `docs/STATUS.md`. For the forward plan, see `docs/CONTINUITY_PLAN.md`.
For binding decisions, see `docs/DECISIONS.md`.

## The shape

```
browser ── apps/web (Next.js :3002) ── BFF /api/nexus/**
   │                                        │
   │                          ┌─────────────┴──────────────┐
   │                          v                            v
   │              services/platform (:8090)        apps/ai (:8010)
   │              Spring Boot monolith          FastAPI (mock LLM by default)
   │                          │                            │
   │                          └──────────┬─────────────────┘
   │                                     v
   │                        Postgres 16 + pgvector (:5433) / Redis (:6380)
   │
   └── (cloud profile, opt-in) ──> nexus-gateway :18088 ── lb:// by Eureka name
                                        │
                    ┌───────────────────┼───────────────────┐
                    v                   v                   v
          nexus-eureka :18761  nexus-config :18888  nexus-admin :19444
          (registry)           (native repo)         (watches only)
```

The Spring Cloud plane is a **sidecar**, not a decomposition of the monolith
(`docs/DECISIONS.md` D2, `docs/ROADMAP.md` §169). The monolith and the AI service stay single-process.

## Product surfaces

| Surface | Source | What it owns |
|---|---|---|
| Consumer / merchant / admin console | `apps/web` | Next.js route groups, BFF proxy, rendered `EntityCard` facts |
| Commerce core | `services/platform` | identity, RBAC, merchants, catalog, carts, reservations, events, admin |
| AI service | `apps/ai` | query understanding, hybrid search, RAG, agent orchestrator, eval, merchant agent |
| Cloud sidecar | `services/cloud` | registry, config, edge gateway, admin window |
| Shared TS | `packages/types`, `packages/ui`, `packages/sdk` | contract types, design system, client SDK |
| Infrastructure | `infra/docker-compose.yml`, `infra/db/migrations`, `infra/config` | compose profiles, Flyway DDL, ranking/market config |
| Demo corpus | `data/seed` | labelled synthetic Hong Kong data (`data_origin='demo'`) |
| Proof | `tests/e2e`, `docs/TESTING.md`, `docs/evidence` | Playwright suites, measured runbook, screenshots |

## Host coordinates (measured free; `scripts/check_cloud_plane_ports.mjs` guards them)

| Port | Service | Declared in |
|---|---|---|
| 3002 · 8090 · 8010 | web · platform · AI | `Makefile`, `README.md` |
| 5433 · 6380 | Postgres · Redis (CI/dev) | `infra/docker-compose.yml` |
| 18761 | `nexus-eureka` | `services/cloud/eureka-server/src/main/resources/application.yaml` |
| 18888 | `nexus-config` | `services/cloud/config-server/src/main/resources/application.yaml` |
| 18088 | `nexus-gateway` | `services/cloud/gateway/src/main/resources/application.yaml` |
| 19444 | `nexus-admin` | `services/cloud/admin-server/src/main/resources/application.yaml` |
| 19555 | `nexus-insight` (D885) | `services/cloud/insight-service/src/main/resources/application.yaml` |
| 18961 / 18962 | reserved for the D858 HA experiment | `docs/CLOUD.md` |

3000 / 8000 / 8080 belong to other projects on this dev machine — see `README.md`.

## The cloud modules

| Module | Build | Application |
|---|---|---|
| Eureka | `services/cloud/eureka-server/pom.xml` | `services/cloud/eureka-server/src/main/java/com/nexus/cloud/eureka/EurekaServerApplication.java` |
| Config | `services/cloud/config-server/pom.xml` | `services/cloud/config-server/src/main/java/com/nexus/cloud/config/ConfigServerApplication.java` |
| Gateway | `services/cloud/gateway/pom.xml` | `services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/GatewayApplication.java` |
| Admin | `services/cloud/admin-server/pom.xml` | `services/cloud/admin-server/src/main/java/com/nexus/cloud/admin/AdminServerApplication.java` |
| Insight (D885) | `services/cloud/insight-service/pom.xml` | `services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/InsightServiceApplication.java` |
| Reactor | `services/cloud/pom.xml` | Spring Boot 3.5.16 / Spring Cloud 2025.0.3, Java 21 |

`nexus-insight` is the first independent service: Eureka member, declarative OpenFeign clients
`services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/PlatformHealthClient.java` and
`services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/AiHealthClient.java`, honest
fallbacks, and the read-only `services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/PlaneController.java`.
D885's smoke proves the fallback path, D886 proves registry membership, D887 proves that `lb://`
resolves to LIVE registered fixtures (not the real products), and D889 adds the
`@RefreshScope` view `services/cloud/insight-service/src/main/java/com/nexus/cloud/insight/ConfigViewController.java`.

Config repo files: `services/cloud/config-server/src/main/resources/config-repo/nexus-gateway.yml`,
`services/cloud/config-server/src/main/resources/config-repo/nexus-platform.yml` and
`services/cloud/config-server/src/main/resources/config-repo/nexus-insight.yml` (D889).

Trace plane (D884): `services/cloud/gateway/src/main/java/com/nexus/cloud/gateway/EdgeTracingFilter.java`
mints/propagates W3C `traceparent`; `apps/ai/nexus_ai/api/tracing.py` parses it on the FastAPI side;
`services/cloud/gateway/src/test/java/com/nexus/cloud/gateway/EdgeTracingFilterTest.java` and
`apps/ai/tests/test_tracing.py` pin the grammar on both stacks.

## Binding documents (all 30 design pages)

| Area | Document |
|---|---|
| Contracts | `docs/API_CONTRACT.md` · `docs/AGENT_CONTRACT.md` · `docs/DECISIONS.md` |
| Architecture | `docs/ARCHITECTURE.md` · `docs/PLAN.md` · `docs/ROADMAP.md` · `docs/DATABASE.md` · `docs/DEPLOYMENT.md` · `docs/OBSERVABILITY.md` |
| AI | `docs/AI.md` · `docs/RAG.md` · `docs/AGENTS.md` · `docs/SEARCH.md` · `docs/RECOMMENDATION.md` |
| Product | `docs/PRODUCT.md` · `docs/VISION.md` · `docs/CONSUMER.md` · `docs/MERCHANT.md` · `docs/GROWTH.md` |
| Surfaces | `docs/API.md` · `docs/UCP.md` · `docs/MCP.md` · `docs/SECURITY.md` |
| Proof & state | `docs/TESTING.md` · `docs/STATUS.md` · `docs/TRACEABILITY.md` · `docs/ENVIRONMENT_REPORT.md` |
| Plane | `docs/CLOUD.md` · `docs/CONTINUITY_PLAN.md` · `docs/README.md` · `docs/ATLAS.md` |

## Read-only readers (the gate census)

| Reader | What it refuses to let drift |
|---|---|
| `scripts/check_cloud_plane.mjs` | the whole sidecar plane: reactor, app names, load-bearing tokens, compose, CI, this doc family |
| `scripts/check_cloud_plane_ports.mjs` | host coordinate ownership (free / ours / foreign) and one port map |
| `scripts/check_cloud_discovery.mjs` | opt-in registration of platform + AI and `lb://` routing by profile |
| `scripts/check_cloud_edge.mjs` | breakers, limiter, request-id, five-method fallbacks, smoke assertions |
| `scripts/check_cloud_trace.mjs` | D884: W3C filter, strict grammar, Python participant, unit tests, smoke, CI step, honesty clause |
| `scripts/check_cloud_insight.mjs` | D885–D889: fifth reactor module, Feign-by-name clients, honest fallbacks, registry/lease shape, D887 live-upstream smoke assertions, D889 config import/`@RefreshScope`, compose, CI, docs, free-or-ours probe of :19555 |
| `scripts/check_plane_coordinates.mjs` | the URLs the browser harness reads |
| `scripts/check_reader_reachability.mjs` | every shipped reader is reachable from a runner |
| `scripts/check_contract_drift.mjs` | undocumented routes, client-only routes, missing served paths |
| `scripts/check_console_a11y.mjs` | landmarks, control names, focus rings, recomputed contrast |
| `scripts/check_console_i18n.mjs` | the console's zh-HK/en copy census |
| `scripts/check_ui_script.mjs` | the zh-HK UI script census |
| `scripts/check_duplicate_keys.mjs` | React list keys that two members could share |
| `scripts/check_slot_keys.mjs` | multi-child slots in the client plane |
| `scripts/check_jsonb_reads.mjs` | jsonb key reads against the gate's declared list |
| `scripts/check_collection_claims.mjs` | claims a seeded collection makes vs its rows |
| `scripts/check_falsifier_registry.mjs` | the falsifier plants (needs a loaded seed) |
| `scripts/check_ledger_sections.mjs` | STATUS/DECISIONS heading numbers, duplicates, uncommitted entries |
| `scripts/check_ledger_eols.mjs` | the ledger's line endings |
| `scripts/check_ledger_numbers.mjs` | numeric claims by noun (needs `--expect`; UNCHECKED by design) |
| `scripts/check_ledger_citations.mjs` | citations inside the ledger text |
| `scripts/check_status_citations.mjs` | every spelled `STATUS §NN` resolves at HEAD |
| `scripts/check_line_cite_drift.mjs` | file:line citations still name their line; D890 batch-prefetches the (blame commit × cited file) blobs through one `git cat-file --batch`, with `--no-prefetch` kept for byte-for-byte comparison |
| `scripts/check_citation_supports_sentence.mjs` | a cited line supports the sentence quoting it |
| `scripts/check_shared_blob_reader.mjs` | D891: both citation readers call the one shared blob reader, no third parser; `--self-test` plants an erased import, a pasted parser and an empty plane |
| `scripts/check_comment_citations.mjs` | citations in source comments |
| `scripts/check_atlas.mjs` | this page: every path exists, every reader/document/smoke is listed |

`scripts/git_blobs.mjs` (D891) is the shared implementation those two readers import: `headTree`
parses the NUL-delimited HEAD tree, `catFileBatch` reads a list of object expressions through one
child process and returns raw Buffers, with missing objects distinguished from an unreached tail.

Runtime verifiers (need a live plane, **not** part of the default read-only sweep):
`scripts/verify_contract_runtime.mjs`, `scripts/verify_served_reads.mjs`,
`scripts/verify_payload_conformance.mjs`, `scripts/verify_consumer_slice.py`.
`scripts/verify_citation_engine_parity.mjs` (D888) and `scripts/verify_line_cite_parity.mjs`
(D891) are different: they need no live plane, run both engines of their reader over a real ledger
excerpt and diff stdout byte for byte — CI invokes both in the wiring-reads step, while
`scripts/verify_all.mjs` is the one-command read-only sweep.

## Smokes (a claim about behaviour needs one of these)

| Smoke | Proves |
|---|---|
| `scripts/cloud_smoke.sh` | config round-trip, gateway route table, breaker trips, admin discovery |
| `scripts/cloud_lb_smoke.sh` | a real request through `lb://NEXUS-PLATFORM` and `lb://NEXUS-AI` |
| `scripts/cloud_refresh.sh` | config edit lands at the edge, no restart |
| `scripts/cloud_monolith_refresh.sh` | config edit lands on the monolith, same pid |
| `scripts/cloud_retry_smoke.sh` | GET retries twice, POST never retries, honest 503 + 5xx counter |
| `scripts/cloud_trace_smoke.sh` | D884: W3C `traceparent` minted / continued / rejected honestly, measured against `scripts/fixture_trace_echo.py` |
| `scripts/insight_smoke.sh` | D885: with Eureka disabled, `/insight/plane` reports both upstreams `unavailable`, never a faked `UP` |
| `scripts/insight_registry_smoke.sh` | D886: with Eureka up, `NEXUS-INSIGHT` appears in `/eureka/apps` as `UP` with the plane's `instance-id` shape |
| `scripts/insight_feign_smoke.sh` | D887: two self-registered fixtures answer `lb://NEXUS-PLATFORM` / `lb://NEXUS-AI`; a runtime switch to a non-UP status is copied verbatim, and the fixtures' access logs prove the calls arrived |
| `scripts/insight_config_smoke.sh` | D889: a config-repo edit (v1 → v2) lands at `/insight/config` after `POST /actuator/refresh`, same pid, no restart |
| `scripts/insight_admin_smoke.sh` | D892: a clean `/instances` baseline, then the fifth member is visible UP in Spring Boot Admin; status read from THAT instance's `statusInfo` |
| `scripts/falsify_insight_admin_smoke.sh` | D892: boots the plane with insight deliberately absent and requires the admin smoke to FAIL while both servers are up |
| `scripts/cloud_ai_admin_smoke.sh` | the FastAPI service shows UP in Spring Boot Admin |
| `scripts/check_launcher_log_mode.sh` | launcher log mode |
| `scripts/demo_live.sh` | the §142 consumer↔merchant loop in one command |
| `scripts/db_gate_fresh.sh` · `scripts/db_apply_migrations.sh` · `scripts/db_schema_drift.sh` | seeded DB gate, migrations, schema drift |
| `scripts/e2e_fresh.sh` · `scripts/seed_truncate_probe.sh` · `scripts/run_platform_dev.sh` | E2E harness, seed probe, dev launcher |
| `scripts/falsify_gate_selftest.sh` | a gate can be falsified |

CI wiring lives in `.github/workflows/ci.yml`; the `cloud` job runs the cloud smokes (including
D892's admin smoke and its absence-arm falsifier) plus the discovery/edge/ports/plane readers,
and the `required` job gates on it.

## Ledger and numbering

`docs/STATUS.md` holds one numbered section per shipped unit (796 sections at D882), with a
"not claimed" paragraph; `docs/DECISIONS.md` holds 300 binding decisions.
`docs/TESTING.md` §8 is the measured live-verification runbook. Numbers in prose are pinned by
`scripts/check_ledger_numbers.mjs` against a real gate run — never by assertion alone.

## How this page is checked

```bash
node scripts/check_atlas.mjs            # every path exists + the census is complete
node scripts/check_atlas.mjs --verbose  # name every checked path
node scripts/check_atlas.mjs --self-test # prove the gate reddens on a broken citation
node scripts/verify_all.mjs             # one command for every read-only reader
```

`scripts/check_atlas.mjs` reads only backticked tokens that look like a repository-relative file
path; prose, commands and shell variables are not paths and are not judged. It also runs the reverse
census: a new `scripts/check_*.mjs`, `docs/*.md`, cloud smoke or module pom that this page does not
list reddens the gate. That is the mechanism that keeps an "integration" page honest as the project
grows.

**What this page does not say:** that any listed gate is currently green (run `scripts/verify_all.mjs`),
that the smokes were run in this session, that the plane is production-ready, or that the monolith
was decomposed into microservices.
