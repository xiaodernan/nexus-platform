# NEXUS cloud plane — what it is and how to run it

Status: **built and locally verified**. Eureka (registry), Config Server, Gateway, Spring Boot Admin, and the discovery lane for both services are on master and re-verified end-to-end by five smokes (plane, LB, edge refresh, monolith refresh, retry). D884 adds W3C `traceparent` propagation across the Java edge and the FastAPI service (proved by a sixth smoke). D885 adds a **fifth, genuinely separate service** — `nexus-insight` — which registers with Eureka and calls the platform and AI by name through OpenFeign + Spring Cloud LoadBalancer (proved by a seventh smoke). Two items do NOT hold (HA replication on this host — D858, container run — D853); this page says exactly what is real.

## What the plane is

A **sidecar** to the monolith, not a replacement: Eureka, Config Server, Gateway and Spring Boot Admin run as their own jars. The monolith and the AI service stay single-process applications. The edge routes to them by `lb://` name through the registry (under a profile each; nothing routes by name by default).

```
browser / BFF
      |
      v
POST /api/v1/**  /ai/v1/**       (the gateway's doors, path-based)
      |
  nexus-gateway :18088 ──traceparent──> both (D884)
      |            |                   (cloud profile resolves both by name)
      v            v
  lb://NEXUS-PLATFORM   lb://NEXUS-AI
      |            |
  platform :8090   AI :8010     (registered only under the cloud profile / opt-in)
      |            |
      v            v
  Postgres 5433     Postgres 5433   (verify2 corpus, seeded demo data, data_origin='demo')
      ^            ^
      |            |  OpenFeign by NAME + LoadBalancer + resilience4j fallback (D885)
      └──── nexus-insight :19555 ────┘   (fifth Eureka member; no DB, no writes)
```
`scripts/cloud_smoke.sh` / `cloud_lb_smoke.sh` / `cloud_refresh.sh` / `cloud_monolith_refresh.sh` prove the wiring without any of this going to production. `cloud_trace_smoke.sh` and `insight_smoke.sh` prove the two newer lanes.

## The port map (measured free)

| port | service | image / jar |
|---|---|---|
| 18761 | `nexus-eureka` (single node) | `services/cloud/eureka-server/target/app.jar` |
| 18888 | `nexus-config` (native file repo) | `services/cloud/config-server/target/app.jar` |
| 18088 | `nexus-gateway` (reactive WebFlux) | `services/cloud/gateway/target/app.jar` |
| 19444 | `nexus-admin` (Spring Boot Admin) | `services/cloud/admin-server/target/app.jar` |
| 19555 | `nexus-insight` (independent service, D885) | `services/cloud/insight-service/target/app.jar` |
| 18961/18962 | reserved for an HA experiment | see D858 |

Compose's `cloud` profile publishes the same four; the Dockerfiles package each jar.
The planes above the registry do NOT move when the monolith's dev ports change (8090/8010) — they are the plane's own coordinates.

## How to bring the plane up (order matters)

```bash
# 1. build once
mvn -B -q -f services/cloud/pom.xml -DskipTests clean package

# 2. run each jar (defaults = the port map above)
java -jar services/cloud/eureka-server/target/app.jar    # :18761
java -jar services/cloud/config-server/target/app.jar    # :18888
java -jar services/cloud/admin-server/target/app.jar     # :19444
java -jar services/cloud/gateway/target/app.jar          # :18088 (plain URI routes)

# 3. bring the services online under the cloud profile (opt-in)
#    platform registers as NEXUS-PLATFORM; AI registers as NEXUS-AI
cd services/platform && mvn -Dspring-boot.run.profiles=dev,cloud spring-boot:run   # :8090
cd apps/ai && NEXUS_AI_EUREKA_ENABLED=true NEXUS_AI_HOST_PORT=8010 \
            NEXUS_EUREKA_URI=http://127.0.0.1:18761/eureka/ \
            uv run python start_ai.py                                       # :8010
```

## What each piece proves

- **Eureka (`nexus-eureka`)** — the registry. Self-preservation OFF, eviction every 5s. Same artifact for every node; `instance-id` is port-suffixed so two nodes can co-exist. `NEXUS_EUREKA_PEER=true` and a comma-separated `NEXUS_EUREKA_ZONE` opt a node into peer mode (see D858 for why that does NOT converge on this host).
- **Config Server (`nexus-config`, native)** — serves `nexus-gateway.yml` from the file `config-repo/`; the gateway resolves `nexus.edge.label` from it (`/cloud/info`). One live edit to that file is picked up without a restart via `POST /actuator/refresh` (proven by `scripts/cloud_refresh.sh`).
- **Gateway (`nexus-gateway`)** — reactive WebFlux edge: path routes (`/api/v1/**` → platform, `/ai/v1/**` → AI, `/**` → web), `@RefreshScope` for config-bound beans, resilience4j breakers per upstream (platform/ai/web) with an honest `edge_upstream_unavailable` 503 fallback + `request_id`, per-client token bucket rate limiter with `429 Retry-After: 1 + edge_rate_limited` (management paths exempt), X-Request-Id honored end-to-end and deduped at the first hop.
- **Admin (`nexus-admin`)** — Spring Boot Admin at `:19444`: every Eureka-registered service is listed live with health, endpoints and metrics. Watches only: `register-with-eureka=false`. Same trusted-hop boundary as the edge (no auth on this dev plane; a deployment ingress owns the door).
- **Discovery** — platform registers only under `dev,cloud` (`application-cloud.yml`, pomer imports the BOM); AI registers only under `NEXUS_AI_EUREKA_ENABLED=true` (`apps/ai/nexus_ai/discovery.py`). Both OFF by default.
- **`nexus-insight` (D885)** — the plane's first genuinely separate service, and the first component that CALLS another service declaratively. It is a servlet/blocking Spring Boot jar (OpenFeign is blocking; putting it in the WebFlux edge would be a lie about the threading model) with `@EnableDiscoveryClient` + `@EnableFeignClients`. `@FeignClient(name = "NEXUS-PLATFORM")` and `@FeignClient(name = "NEXUS-AI")` resolve through Eureka + Spring Cloud LoadBalancer — no host or port literal on either interface. `spring-cloud-starter-circuitbreaker-resilience4j` gives Feign's `fallback=` a real `CircuitBreakerFactory`; each fallback returns an explicit `insight_fallback: true` marker and `status: unavailable`, **never** `UP`. `GET /insight/plane` aggregates only the upstream's own `status` (the rest of its payload is not forwarded), calls a status-less answer `unknown`, reports exceptions as `unavailable`, and sets `all_up` true only when both rows answered exactly `UP`. It owns no database and writes nothing — this is a sidecar observer, not a decomposition of the monolith. Java: 4 tests (`PlaneControllerTest`); `scripts/insight_smoke.sh` boots it with Eureka **disabled** and proves both rows are reported unavailable with no faked health.
- **W3C trace propagation (D884)** — the edge is the plane's only trace-id origin. `EdgeTracingFilter` (`HIGHEST_PRECEDENCE + 1`, immediately after `X-Request-Id`) parses a strict, lowercase version-00 `traceparent` (`00-<32 hex>-<16 hex>-<2 hex>`, all-zero ids refused), continues a valid caller's trace-id and flags under a NEW child span-id, and mints a fresh context when the header is absent or malformed. It injects `traceparent` + `X-Trace-Id` downstream and echoes `X-Trace-Id` / `X-Trace-Span-Id` to the caller — it deliberately does NOT echo `traceparent` on responses, because W3C propagates that header on requests only. The FastAPI AI service is a **participant, not an origin**: `apps/ai/nexus_ai/api/tracing.py` uses the same strict grammar, echoes the edge-minted trace id on `x-trace-id` / `x-trace-parent-id`, and mints nothing when a caller reached it directly with no header. `/actuator/info` declares `role: participant`, `mints_trace_ids: false`, `exports_spans: false` so the admin window cannot be read as a claim of instrumentation. Java: 6 tests (`EdgeTracingFilterTest`); Python: 6 tests (`apps/ai/tests/test_tracing.py`). `scripts/cloud_trace_smoke.sh` proves all three arms on the wire against `scripts/fixture_trace_echo.py`, which echoes exactly what the downstream received.
- **Monolith config (opt-in, D872)** — the platform resolves its OWN config from the same config server, only under `dev,cloud`: `spring.config.import: optional:configserver:${NEXUS_CONFIG_URI:http://127.0.0.1:18888}` and `spring.cloud.config.enabled=true`; the base `application.yml` carries `spring.cloud.config.enabled=false` so the normal boot ignores the config starter entirely (Boot's import check would refuse to start otherwise — found the hard way, fixed in the same unit). The `nexus-platform.yml` in the native repo carries a demo banner marker; `GET /api/v1/cloud/info` shows the banner the monolith resolved, `POST /actuator/refresh` (exposed under `cloud` only) hot-reloads it via `@RefreshScope` (proven by `scripts/cloud_monolith_refresh.sh`: v1 → rewrite repo → POST refresh → v2, same pid). Without the config server the monolith boots normally with local defaults.

## The gates that hold this honest

| gate | what it proves |
|---|---|
| `check_cloud_plane_ports.mjs` | every host coordinate belongs to a service this repo declares |
| `check_cloud_plane.mjs` | the whole plane, one reader (D878): reactor modules; app names/host ports; the load-bearing tokens (HA guard, window-not-wider, breakers, backoff, GET-only retry); compose `cloud` profile; CI job wiring; this page — **53 checks** (D878's 51 + D880's edge counter + D885's fifth module) |
| `check_cloud_discovery.mjs` | the platform and AI register by opt-in; the edge routes lb:// by profile; env override wins; smoke proofs exist |
| `check_cloud_edge.mjs` | breaker + fallback + limiter + request-id wiring is intact |
| `check_cloud_trace.mjs` | D884: the W3C filter, the strict grammar, the Python participant, the unit tests, the smoke, the CI step and this page's honesty clause are all wired |
| `check_cloud_insight.mjs` | D885: the fifth reactor module, the declarative clients, the honest fallbacks, the registry/lease shape, compose, CI, both docs and a live free-or-ours probe of :19555 |
| `cloud_smoke.sh` | config server round-trip, gateway resolves config, route table, breaker trips on dead port, NEXUS-ADMIN discovery smoke (admin passes and lists the gateway) |
| `cloud_lb_smoke.sh` | one REAL `/api/v1/health` through lb://NEXUS-PLATFORM, one through lb://NEXUS-AI; X-Request-Id echo; deterministic limiter |
| `cloud_refresh.sh` | config edit lands at the edge with no restart (`POST /actuator/refresh`) |
| `cloud_monolith_refresh.sh` | config edit lands ON THE MONOLITH with no restart (v1 → repo rewrite → POST refresh → v2 banner, same pid) |
| `cloud_retry_smoke.sh` | idempotent GET retries twice past a transient 5xx upstream; POSTs never retried; failing POST lands `edge_upstream_unavailable` (503); `nexus.edge.response.5xx == 1` (the fallback 503 — the two 500s never leave the wire, the Retry filter writes a final 200); actuator carries `http.server.requests` + `resilience4j.circuitbreaker.*` (the gateway Retry filter itself emits no meter) |
| `cloud_ai_admin_smoke.sh` | the FastAPI service shows UP in the Spring Boot Admin (`/instances` — the Python service joins the window) |
| `cloud_trace_smoke.sh` | D884: with no `traceparent` the edge mints one and the fixture sees the same context; with a valid one the trace-id/flags survive and the span-id becomes a child; with a malformed one a fresh trace-id replaces it |
| `insight_smoke.sh` | D885: with Eureka disabled and no upstream, `/insight/plane` answers `all_up=false` and both rows `unavailable` — no fallback impersonates a healthy service |
| `db_gate_fresh.sh` | the seeded database gate (unrelated plane; not the cloud job's dependency) |

The `cloud` CI job (`.github/workflows/ci.yml`) runs `cloud_smoke.sh`, all readers (ports, discovery, edge, plane, trace, atlas, insight — chained on one wiring line so no cited line number in the ledger moves), applies migrations and `cloud_lb_smoke.sh`, then the refresh/monolith-refresh/retry + trace + insight smokes and the ai-admin smoke. The gate `needs.cloud` is in the `required` job's `needs`.

## What this plane does NOT claim (read this)

- **No HA.** Two Eureka nodes were built and measured: the replica resolver refuses to exclude a node from its own zone, so each node saw only the other — and the LAN address this host resolves is unroutable from loopback. See D858. Single-node Eureka + the gateway circuit breaker is what ships today.
- **No auth / TLS / rate limiting for the admin and eureka surface.** The edge does not authenticate; the admin server is not publicly reachable either; a real ingress would be a separate decision.
- **No service mesh, no circuit-breaker restart, no transactional outbox on the edge.**
- **No trace collector.** D884 propagates W3C context and proves it on the wire; there is no OTLP exporter, no span storage, no sampling decision beyond carrying the caller's flags, and no span tree anyone can query. `X-Trace-Id` is a correlation id across two hops, not an observability backend. The AI service parses and echoes; it has no Micrometer/Spring instrumentation.
- **`nexus-insight` is not a health authority and not a decomposition.** Its smoke proves the FALLBACK path with Eureka deliberately disabled: no real platform/AI instance answered, no `lb://` name was resolved against a live registry, and nothing claims service discovery succeeded end to end on this host. Its `insight_smoke.sh` does not exercise the Docker image (D853 still holds). The monolith keeps its database, schema and transactions; the new service has none of them and writes nothing. Its actuator surface is as unauthenticated as the rest of this dev plane.
- **Docker deployment is not verified.** Compose's `cloud` profile is defined and the image recipe is correct on this host, but the containers never transitioned out of `Created` — the host's Docker daemon was too saturated. See D853.
- **Retention.** The Eureka lease defaults are aggressive by design (self-preservation off, eviction every 5s) — appropriate for a dev plane, not for prod.

## The standing rule for new Spring Cloud work

A new host coordinate runs `scripts/check_cloud_plane_ports.mjs` first. D885's :19555 sits outside that reader's three-module census, so `scripts/check_cloud_insight.mjs` asks the same free-or-ours question for it instead (and the three-coordinate reader was re-run PASS before the new port was declared). A new service joins the registry with the same shape (`instance-id: name:port`, lease 5s/10s, findable not a client) or it does not join. A new check is only real when it has a smoke to prove it. A new service-to-service call is declarative and by NAME, never a hardcoded host:port literal.
