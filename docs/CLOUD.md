# NEXUS cloud plane — what it is and how to run it

Status: **built and locally verified**. Eureka (registry), Config Server, Gateway, Spring Boot Admin, and the discovery lane for both services are on master and re-verified end-to-end by five smokes (plane, LB, edge refresh, monolith refresh, retry). Two items do NOT hold (HA replication on this host — D858, container run — D853); this page says exactly what is real.

## What the plane is

A **sidecar** to the monolith, not a replacement: Eureka, Config Server, Gateway and Spring Boot Admin run as their own jars. The monolith and the AI service stay single-process applications. The edge routes to them by `lb://` name through the registry (under a profile each; nothing routes by name by default).

```
browser / BFF
      |
      v
POST /api/v1/**  /ai/v1/**       (the gateway's doors, path-based)
      |
  nexus-gateway :18088
      |            |                   (cloud profile resolves both by name)
      v            v
  lb://NEXUS-PLATFORM   lb://NEXUS-AI
      |            |
  platform :8090   AI :8010     (registered only under the cloud profile / opt-in)
      |            |
      v            v
  Postgres 5433     Postgres 5433   (verify2 corpus, seeded demo data, data_origin='demo')
```
`scripts/cloud_smoke.sh` / `cloud_lb_smoke.sh` / `cloud_refresh.sh` / `cloud_monolith_refresh.sh` prove the wiring without any of this going to production.

## The port map (measured free)

| port | service | image / jar |
|---|---|---|
| 18761 | `nexus-eureka` (single node) | `services/cloud/eureka-server/target/app.jar` |
| 18888 | `nexus-config` (native file repo) | `services/cloud/config-server/target/app.jar` |
| 18088 | `nexus-gateway` (reactive WebFlux) | `services/cloud/gateway/target/app.jar` |
| 19444 | `nexus-admin` (Spring Boot Admin) | `services/cloud/admin-server/target/app.jar` |
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
- **Monolith config (opt-in, D872)** — the platform resolves its OWN config from the same config server, only under `dev,cloud`: `spring.config.import: optional:configserver:${NEXUS_CONFIG_URI:http://127.0.0.1:18888}` and `spring.cloud.config.enabled=true`; the base `application.yml` carries `spring.cloud.config.enabled=false` so the normal boot ignores the config starter entirely (Boot's import check would refuse to start otherwise — found the hard way, fixed in the same unit). The `nexus-platform.yml` in the native repo carries a demo banner marker; `GET /api/v1/cloud/info` shows the banner the monolith resolved, `POST /actuator/refresh` (exposed under `cloud` only) hot-reloads it via `@RefreshScope` (proven by `scripts/cloud_monolith_refresh.sh`: v1 → rewrite repo → POST refresh → v2, same pid). Without the config server the monolith boots normally with local defaults.

## The gates that hold this honest

| gate | what it proves |
|---|---|
| `check_cloud_plane_ports.mjs` | every host coordinate belongs to a service this repo declares |
| `check_cloud_discovery.mjs` | the platform and AI register by opt-in; the edge routes lb:// by profile; env override wins; smoke proofs exist |
| `check_cloud_edge.mjs` | breaker + fallback + limiter + request-id wiring is intact |
| `cloud_smoke.sh` | config server round-trip, gateway resolves config, route table, breaker trips on dead port, NEXUS-ADMIN discovery smoke (admin passes and lists the gateway) |
| `cloud_lb_smoke.sh` | one REAL `/api/v1/health` through lb://NEXUS-PLATFORM, one through lb://NEXUS-AI; X-Request-Id echo; deterministic limiter |
| `cloud_refresh.sh` | config edit lands at the edge with no restart (`POST /actuator/refresh`) |
| `cloud_monolith_refresh.sh` | config edit lands ON THE MONOLITH with no restart (v1 → repo rewrite → POST refresh → v2 banner, same pid) |
| `cloud_retry_smoke.sh` | idempotent GET retries twice past a transient 5xx upstream; POSTs never retried; failing POST lands `edge_upstream_unavailable` (503) |
| `db_gate_fresh.sh` | the seeded database gate (unrelated plane; not the cloud job's dependency) |

The `cloud` CI job (`.github/workflows/ci.yml`) runs `cloud_smoke.sh`, both readers, applies migrations, `cloud_lb_smoke.sh`, then the refresh smoke, the monolith-refresh smoke and the retry smoke. The gate `needs.cloud` is in the `required` job's `needs`.

## What this plane does NOT claim (read this)

- **No HA.** Two Eureka nodes were built and measured: the replica resolver refuses to exclude a node from its own zone, so each node saw only the other — and the LAN address this host resolves is unroutable from loopback. See D858. Single-node Eureka + the gateway circuit breaker is what ships today.
- **No auth / TLS / rate limiting for the admin and eureka surface.** The edge does not authenticate; the admin server is not publicly reachable either; a real ingress would be a separate decision.
- **No service mesh, no circuit-breaker restart, no transactional outbox on the edge.**
- **Docker deployment is not verified.** Compose's `cloud` profile is defined and the image recipe is correct on this host, but the containers never transitioned out of `Created` — the host's Docker daemon was too saturated. See D853.
- **Retention.** The Eureka lease defaults are aggressive by design (self-preservation off, eviction every 5s) — appropriate for a dev plane, not for prod.

## The standing rule for new Spring Cloud work

A new host coordinate runs `scripts/check_cloud_plane_ports.mjs` first. A new service joins the registry with the same shape (`instance-id: name:port`, lease 5s/10s, findable not a client) or it does not join. A new check is only real when it has a smoke to prove it.
