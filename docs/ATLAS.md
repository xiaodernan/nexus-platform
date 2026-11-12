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
| 18961 / 18962 | D894's throwaway HA pair (loopback aliases, not in the cloud profile) | `docs/CLOUD.md` |

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
| `scripts/check_cloud_trace_fallback.mjs` | D896: the 200/503/429 trace smoke, its no-degrade falsifier, the filter ORDER (tracing before the limiter), CI/ATLAS/ledger wiring, and a self-test that plants eight corruptions |
| `scripts/check_cloud_ha_failover.mjs` | D897: the empty-cache anti-false-positive design, the primary kill, the LATE registration on the secondary, the single-registry falsifier, the NOT-SHIPPED honesty clause, and nine planted corruptions |
| `scripts/check_cloud_claims.mjs` | D898: the machine-readable claim census — restricted-YAML grammar, four-element completeness, script/reader existence, CI/CLOUD/ATLAS wiring, honesty anchors, a reverse census, and 13 planted corruptions |
| `scripts/check_cloud_insight.mjs` | D885–D889: fifth reactor module, Feign-by-name clients, honest fallbacks, registry/lease shape, D887 live-upstream smoke assertions, D889 config import/`@RefreshScope`, compose, CI, docs, free-or-ours probe of :19555 |
| `scripts/check_cloud_insight_trace.mjs` | D900: the fifth service (`nexus-insight`) joins the W3C trace plane as a participant — strict version-00 `traceparent` grammar, trace id preserved end-to-end through the Feign boundary, child span minted per hop, `X-Trace-Id` echoed on the response, the disabled-participation falsifier must redden |
| `scripts/insight_trace_smoke.sh` | D900: wire proof — one caller traceparent reaches BOTH `lb://` upstreams; each live fixture logs the received context; phase B degraded arm echoes the SAME trace id on fallback |
| `scripts/falsify_insight_trace_smoke.sh` | D900: turning participation off makes the trace smoke exit non-zero, with the healthy 200 control proving the red is attributable to missing participation |
| `scripts/check_plane_coordinates.mjs` | the URLs the browser harness reads |
| `scripts/check_reader_reachability.mjs` | every shipped reader is reachable from a runner |
| `scripts/check_contract_drift.mjs` | undocumented routes, client-only routes, missing served paths |
| `scripts/check_console_a11y.mjs` | landmarks, control names, focus rings, recomputed contrast |
| `scripts/check_tinted_contrast.mjs` | D956: closes the tinted-ground blind spot the a11y reader declares — reads the 4 opaque `bg-*-soft` + `text-*` pairings from Badge.tsx's cva tone table (contract: a missing tone reddens), resolves both tokens in the light and dark blocks of tokens.css and recomputes the same WCAG ratio, requiring all 4 tones x 2 themes >= 4.5:1 (tightest: light positive-on-soft 4.75:1); source text only, no browser; `--self-test` plants corruptions with a no-op snapshot guard |
| `scripts/check_console_i18n.mjs` | the console's zh-HK/en copy census |
| `scripts/check_ui_script.mjs` | the zh-HK UI script census |
| `scripts/check_duplicate_keys.mjs` | React list keys that two members could share |
| `scripts/check_slot_keys.mjs` | multi-child slots in the client plane |
| `scripts/check_jsonb_reads.mjs` | jsonb key reads against the gate's declared list |
| `scripts/check_collection_claims.mjs` | claims a seeded collection makes vs its rows |
| `scripts/check_falsifier_registry.mjs` | the falsifier plants (needs a loaded seed) |
| `scripts/check_ledger_sections.mjs` | STATUS/DECISIONS heading numbers, duplicates, uncommitted entries |
| `scripts/check_ledger_eols.mjs` | the ledger's line endings |
| `scripts/check_ledger_encoding.mjs` | D959: the prose plane's character encoding census — every tracked `*.md` is scanned for forbidden codepoints (C0 except HT/LF/CR, DEL, C1 80..9F, U+FFFD) and for byte-exact bijective Latin-1 mis-read runs (latin1->UTF-8 round-trip proves the inverse, so no glyph is guessed); 89 codepoints + 28 runs were found across 4 files and repaired in their own EOL planes, the 2 unrecoverable glyphs marked with a greppable `[U+FFFD]` sentinel; ledger wiring is line-anchored so the reader's own prose cannot hold it; `--self-test` plants 10 arms (6 byte corruptions + 3 wiring cuts + reader-absent) + a legitimate non-ASCII GREEN guard, each cause-checked with a no-op snapshot |
| `scripts/check_ledger_numbers.mjs` | numeric claims by noun (needs `--expect`; UNCHECKED by design) |
| `scripts/check_ledger_citations.mjs` | citations inside the ledger text; D893 batch-prefetches only the HEAD blobs its own citations name, with `--no-prefetch` kept for byte-for-byte parity |
| `scripts/check_status_citations.mjs` | every spelled `STATUS §NN` resolves at HEAD |
| `scripts/check_line_cite_drift.mjs` | file:line citations still name their line; D890 batch-prefetches the (blame commit × cited file) blobs through one `git cat-file --batch`, with `--no-prefetch` kept for byte-for-byte comparison |
| `scripts/check_citation_supports_sentence.mjs` | a cited line supports the sentence quoting it |
| `scripts/check_shared_blob_reader.mjs` | D891: both citation readers call the one shared blob reader, no third parser; `--self-test` plants an erased import, a pasted parser and an empty plane |
| `scripts/check_java_basenames.mjs` | D930: every shipped Java source basename is unique, so a ledger's bare `Class:NN` cite cannot be made ambiguous by a new module; `--self-test` plants two real collisions and two non-collisions |
| `scripts/check_events_group.mjs` | D931: the opt-in consumer-group seam — real `XGROUP`/`XREADGROUP`/`XACK`/`XPENDING` calls, default-off flag, replay offsets, `/events/group` endpoint, split assertion + falsifier, unit test and CI/ATLAS/CLOUD/census/ledger wiring; `--self-test` plants seven corruptions |
| `scripts/check_atomic_ratelimit.mjs` | D932: the Redis limit counter's INCR+first-write EXPIRE live in ONE Lua `EVAL` (no counter without a ttl), with a live-Redis positive arm and a mock falsifier that reproduces the TTL-less lockout on the legacy split, plus the two wire-level smokes' assertions and CI/CLOUD/ATLAS/census/ledger wiring; `--self-test` plants eight corruptions |
| `scripts/ratelimit_atomicity_smoke.sh` | D932: the live-Redis proof of the split fix — INCR now arms TTL atomically; the next INCR counts without re-arming the fixed window |
| `scripts/falsify_ratelimit_atomicity_smoke.sh` | D932: the mock falsifier that reproduces the TTL-less lockout on the legacy split path while the D932 path stays clean |
| `scripts/check_sliding_window.mjs` | D937: the atomic Redis-ZSET sliding window closes fixed-window's boundary burst — all four ZSET commands in ONE Lua EVAL, injected nowMs, opt-in default OFF, D932 fixed path preserved, bounded fallback, source + CI/ATLAS/CLOUD/census/ledger wiring; `--self-test` plants eight corruptions |
| `scripts/sliding_window_smoke.sh` | D937: live-Redis proof that fixed admits 2×limit across a boundary while the source Lua's sliding window holds it to limit, then a hit a window later sweeps old scores and reopens it |
| `scripts/falsify_sliding_window_smoke.sh` | D937: deletes the `ZREMRANGEBYSCORE` line from the source Lua and requires the reset assertion to REDDEN (ZCARD keeps climbing = permanent throttle) while the intact-script control still resets to 1 |
| `scripts/check_ttl_jitter.mjs` | D940: cache-TTL decorrelation is OPT-IN (default OFF); the FNV-1a 64 constants + unsigned remainder + golden vector are pinned, set() keeps the D909 SETEX off-path and issues ONE atomic PSETEX when on, and the D932 counter / D937 sliding window / SETNX replay-dedup are proved UNPOLLUTED; `--self-test` plants eight corruptions |
| `scripts/ttl_jitter_smoke.sh` | D940: live-Redis proof that a batch of same-TTL keys collapses to 1 expiry bucket WITHOUT jitter and spreads to >= 16 buckets WITH the source's unsigned-FNV offset, never shorter than base, with a stable per-key offset |
| `scripts/falsify_ttl_jitter_smoke.sh` | D940: plants the SIGNED remainder in the source-extracted formula and requires the "never shorter than base" assertion to REDDEN (10/64 keys expire early) while the unsigned control keeps all TTLs >= base |
| `scripts/check_singleflight.mjs` | D944: N concurrent misses for one cold key collapse into ONE load via an atomic putIfAbsent in-flight election; opt-in (default OFF) wired into ApiKeyService.verify()'s miss path, failure propagates to all joiners and the in-flight entry is cleared, D933 LRU path preserved; `--self-test` plants eight corruptions |
| `scripts/singleflight_smoke.sh` | D944: compiles the actual Singleflight.java + a harness, runs N=16 real JVM threads with a CountDownLatch gate and asserts LOADS=1 / WAITERS=16, a failure reaching all joiners and a cleared in-flight entry (next call reloads) |
| `scripts/falsify_singleflight_smoke.sh` | D944: deletes only the atomic putIfAbsent merge from a temp source copy and requires the "LOADS == 1" assertion to REDDEN (LOADS=16 = the N-fold stampede) while the intact-source control still coalesces to 1 |
| `scripts/check_d950.mjs` | D950: an opt-in (default OFF) third poll arm calls the real Lettuce `xautoclaim()` with a min-idle-time threshold, follows the bounded server cursor, XACKs each rescued entry after its ring push, exposes a `reclaimed` counter over `/events/group`, keeps all four constructor shapes and leaves D929 tail + D931 group byte-for-byte; `--self-test` plants nine corruptions |
| `scripts/check_d952.mjs` | D952: the e2e CI job boots Postgres via `docker compose` (database `nexus`, superuser `postgres`/`postgres`, AI role `nexus_ai`/`nexus_dev_ai_only`, port 5433), NOT the `platform`/`ai`/`cloud` jobs' GitHub service container (`nexus_test`/`ci_secret`/`ci_nexus_ai`); the reader pins the three repaired compose-plane coordinates, requires the service-container tokens to be absent from the e2e segment alone, reads the compose defaults so a rename reddens, holds ci.yml at 535 cited-line-stable lines, and admits `--ci=<path>` reverse control; `--self-test` plants eleven corruptions |
| `scripts/check_shared_cache_async.mjs` | D962: the opt-in shared tool-result cache called *synchronous* redis-py `get()`/`set()` socket I/O bare on the uvicorn event loop, serial
| `scripts/check_dispatcher_service.mjs` | D973: the sixth Spring Cloud sidecar — HMAC-SHA256 sighed outbound webhooks with backoff+jitter, a Redis DLQ, a per-hook circuit breaker, an inert default (zero hooks, never POSTs); the reader owns the structural claims tests cannot keep (module on the reactor, empty default, monotonic clock, own consumer group `nexus-dispatchers`, HMAC-SHA256, fnv1a64 unsigned-remainder jitter, ledger/CI/ATLAS wiring); `--self-test` plants corruptions each expected to redden the real plane while the holds stay green |ising every concurrent request and freezing the per-tool `asyncio.wait_for`; the two hot-path calls now offload with `await asyncio.to_thread(...)`, keeping the sync client, fail-fast boot ping, offline degrade, canonical key, TTL, default-OFF gate and audit outcome unchanged (no async-client rewrite); the runtime proof `apps/ai/tests/test_shared_cache_does_not_block_event_loop.py` drives a real dispatch with a blocking stub + heartbeat (positive `ticks >= 4`, falsifier inlines the call and requires `ticks <= 2`); `--self-test` plants fourteen corruptions + a GREEN control with D954 no-op and D959 line-anchored guards; CI line 171, the ai-job `uv run pytest -q`, ATLAS and the ledger are wired |
| `scripts/check_eureka_deregister.mjs` | D965: the AI service graceful shutdown called the *asynchronous* `EurekaClient.stop()` coroutine BARE inside `async def Registration.stop`, so the DOWN de-registration DELETE was never scheduled, the heartbeat timer was never cancelled, Python exited with `RuntimeWarning: coroutine was never awaited`, and under the opt-in registry plane a killed AI replica stayed listed in Eureka until its 10s lease self-expired (the inverse of D962: there a blocking sync call sat ON the async loop; here an async call was left OFF it); the single-line fix awaits it under a bound (`await asyncio.wait_for(self.client.stop(), timeout=_DEREGISTER_TIMEOUT_S)`), preserving the fail-open degrade, the awaited FastAPI lifespan caller chain, the opt-in default-OFF env gate and the heartbeat renew/cancel tasks, with no client-library rewrite; the offline probe `apps/ai/tests/test_eureka_deregister_is_awaited.py` drives the real `Registration.stop()` with a stub client (positive sets the flag, a one-flipped-variable falsifier drops the coroutine and requires the flag to stay clear plus the never-awaited warning, a hanging-registry arm proves shutdown stays bounded); `--self-test` plants fifteen corruptions + a GREEN control with D954 no-op and D959 line-anchored guards, and reads the expect tag from either tuple shape from the start; CI line 171, the ai-job `uv run pytest -q`, ATLAS and the ledger are wired |
| `scripts/check_platform_client_reuse.mjs` | D969: the AI→platform adapter built a fresh `httpx.AsyncClient` with `async with` on EVERY relay (get_merchant / create_cart / … / the per-turn dialogue write in `apps/ai/nexus_ai/api/routes_stream.py`), so each call paid a new TCP (and TLS) handshake with no keep-alive, inflating RTT and TIME_WAIT/fd pressure while the factory `get_platform_client` is already a per-process singleton (the D904 candidate `docs/PLAN.md` registered, whose door is a counting transport proving one connection serves N relays); the fix gives `HttpPlatformClient` one lazily-built `_http()` client with a `client=` injection point and `async def aclose()`, and the factory exposes `aclose_platform_client()` (a duck-typed no-op for the stub) which the FastAPI lifespan calls on shutdown beside `stop_eureka`, leaving the timeout / HTTPError→PlatformUnavailable / status→PlatformRejectedRequest / `_safe_json` / headers / idempotency / default-stub / factory-singleton contracts byte-for-byte (mirrors `apps/ai/nexus_ai/models/base.py`); the offline probe `apps/ai/tests/test_platform_client_reuses_connection.py` drives N relays through ONE injected client with `httpx.MockTransport` (positive: N requests + one aclose; falsifier: monkeypatch `_http` back to per-call construction and require the count to become N; plus concurrency, lazy-timeout, shutdown-hook, contract-survival and singleton arms); `--self-test` plants twenty-one corruptions + a GREEN control with D954 no-op and D959 line-anchored guards, and reads the expect tag from either tuple shape from the start; CI line 171, the ai-job `uv run pytest -q`, ATLAS and the ledger are wired |
| `scripts/check_cache_heap_bounded.mjs` | D972: the AI tool-result cache `_Cache` in `apps/ai/nexus_ai/tools/registry.py` bounded its `_store` LRU (D903, door `apps/ai/tests/test_d903_cache_is_bounded.py`) but NOT its D913 expiry min-heap `_expiry_heap`: `set()` pushed one `(expires, ck)` tuple per write and `heapq` has no O(log n) arbitrary delete, so LRU eviction (`popitem`) and overwrites stranded stale tuples until their TTL came due (never under a frozen clock) -- measured cap=8, 2000 distinct-arg writes -> store=8 but heap=2000 (250x), overwrite one key 500x -> heap=500, so memory and sweep cost grew with DISTINCT ARGS SEEN, contradicting D903's own 'bounded by the cap' docstring; the shipped door inspected only `_store`, never the heap. The fix carries a generation: `_seq` + `_heap_token[ck]` record the one live tuple's seq per stored key (a store-only membership filter cannot dedupe repeated identical-expires writes of one key), each `set` supersedes the token / drops the evicted key's token, an expired `get` drops its token, `_sweep_expired` deletes only when token==seq and the store still holds that exact expires, and once the heap exceeds `_compact_factor * max_entries + 1` an amortized `_compact_heap()` rebuilds from live tuples + `heapify` -- per-write cost stays O(log n) (D913) while the heap is now O(cap) (D903), with TTL/LRU/overwrite/expired-sweep semantics and the D903/D913 ledgers byte-for-byte; the offline probe `apps/ai/tests/test_d972_cache_heap_is_bounded.py` (fake clock, 6 arms, no Redis/DB/network/JVM) bounds the heap after 2000 churn writes and requires `len(_heap_token) == len(_store)`, its one-flipped-variable falsifier monkeypatches `_compact_heap` to a no-op and requires write-count growth (heap=2000), plus overwrite, generation-guard, expired-read-token and D903-semantic arms (3x stable 6 passed); `--self-test` plants thirty corruptions + a GREEN control with D954 no-op and D959 line-anchored guards, carries a dedicated ATLAS-PROBE flip arm so every forward offender has a reddening twin, and reads the expect tag from either tuple shape; CI line 171, the ai-job `uv run pytest -q`, ATLAS and the ledger are wired |
| `scripts/check_embedding_cache_bounded.mjs` | D974: the module-level `apps/ai/nexus_ai/models/embeddings.py::_CACHE` was a plain dict keyed by `(name/model, RAW TEXT)`; the text is external input (a RAG query from `apps/ai/nexus_ai/api/routes_rag.py`, a document chunk from `apps/ai/nexus_ai/rag/embed.py`), high-cardinality and caller-controlled, and each value is a 1024-d float tuple (~32 KB). The DEV-DEFAULT `HashingEmbedding.embed_one` wrote it unconditionally, so with NO infra configured every distinct query/chunk was retained forever — measured 2000 distinct queries -> 2000 entries -> ~62 MiB. This is D903/D972's hole on a module those units never touched (their doors inspect `apps/ai/nexus_ai/tools/registry.py`, never this dict), so CI never saw it; it is also directly traffic-driven memory exhaustion. The same module's `HttpEmbedding.embed` did `client = self._client or httpx.AsyncClient(...)` plus a `finally: await client.aclose()` on EVERY call, paying a full TCP(+TLS) handshake per embed — D969's hole, still open on a second adapter. The fix makes `_CACHE` an `OrderedDict` capped at `_CACHE_MAX=4096` (a ~128 MiB ceiling): `_cache_get` promotes a hit (`move_to_end`) and `_cache_put` drops the coldest entry (`popitem(last=False)`) past the cap — O(1) per op, so the hot-set hit cost is unchanged (D913's discipline) while memory is now O(cap); BOTH write paths route through the helpers and NO returned vector changes. Client reuse: a module-level `_HTTP_CLIENT` lazily built by `_shared_client` and released by `aclose_embedding_client()` in the lifespan, while an injected client is still used verbatim and never closed by a call; the factory still returns a FRESH adapter per call (only the connection is shared). DIM=1024, D507 endpoint-index placement, D705 semantic verdicts and the factory-degrade contract are byte-for-byte. The offline probe `apps/ai/tests/test_d974_embedding_cache_is_bounded.py` (fake text + stub client, no network/DB/Redis/JVM) proves 6 arms: cap bound under 2000-query churn, a one-flipped-variable falsifier that disables eviction and requires write-count growth (2000), LRU-not-FIFO promotion, vector byte-invariance, one pooled client for N embeds + shutdown release, and a per-call/ injected-client contract arm (3x stable 6 passed, 67 passed with the cache/eureka/platform/semantic regressions; ruff+mypy clean); `--self-test` plants thirty-four corruptions + a GREEN control with D954 no-op and D959 line-anchored guards, a dedicated ATLAS-PROBE flip arm so every forward offender has a reddening twin, and reads the expect tag from either tuple shape; CI line 171, the ai-job `uv run pytest -q`, ATLAS and the ledger are wired |
| `scripts/events_claim_smoke.sh` | D950: compiles the actual EventsReader.java + EventsRing.java + a harness (offline classpath, no Spring Boot JVM) and drives real Lettuce XAUTOCLAIM on live Redis — N entries stranded under a raw-XREADGROUP dead consumer are reclaimed (PEL 6->0), claim OFF leaves all 6 pending, a 600000ms min-idle refuses a fresh entry, bounded batches drain a 7-entry PEL |
| `scripts/falsify_events_claim_smoke.sh` | D950: removes only the `reclaimDeadPending(me)` call from a temp source copy, recompiles, and requires the `RECOVERY` assertion to REDDEN (reclaimed=0, PEL stays 6) while the intact control drains — one flipped variable |
| `scripts/check_comment_citations.mjs` | citations in source comments |
| `scripts/check_atlas.mjs` | this page: every path exists, every reader/document/smoke is listed |

`scripts/git_blobs.mjs` (D891) is the shared implementation those two readers import: `headTree`
parses the NUL-delimited HEAD tree, `catFileBatch` reads a list of object expressions through one
child process and returns raw Buffers, with missing objects distinguished from an unreached tail.

Runtime verifiers (need a live plane, **not** part of the default read-only sweep):
`scripts/verify_contract_runtime.mjs`, `scripts/verify_served_reads.mjs`,
`scripts/verify_payload_conformance.mjs`, `scripts/verify_consumer_slice.py`.
`scripts/verify_citation_engine_parity.mjs` (D888), `scripts/verify_line_cite_parity.mjs`
(D891) and `scripts/verify_ledger_cite_parity.mjs` (D893) are different: they need no live plane,
run both engines of their reader over a real ledger plane and diff stdout byte for byte — CI invokes
all three in the wiring-reads step, while `scripts/verify_all.mjs` is the one-command read-only sweep.

## Smokes (a claim about behaviour needs one of these)

| Smoke | Proves |
|---|---|
| `scripts/cloud_smoke.sh` | config round-trip, gateway route table, breaker trips, admin discovery |
| `scripts/cloud_lb_smoke.sh` | a real request through `lb://NEXUS-PLATFORM` and `lb://NEXUS-AI` |
| `scripts/cloud_refresh.sh` | config edit lands at the edge, no restart |
| `scripts/cloud_monolith_refresh.sh` | config edit lands on the monolith, same pid |
| `scripts/cloud_retry_smoke.sh` | GET retries twice, POST never retries, honest 503 + 5xx counter |
| `scripts/cloud_trace_smoke.sh` | D884: W3C `traceparent` minted / continued / rejected honestly, measured against `scripts/fixture_trace_echo.py` |
| `scripts/cloud_trace_fallback_smoke.sh` | D896: ONE inbound `traceparent` survives all three gateway answers — healthy 200, breaker 503 fallback and limiter 429 — with the same trace id and a fresh child span on each |
| `scripts/falsify_cloud_trace_fallback_smoke.sh` | D896: with the AI route pointed at the healthy fixture, no 503 exists and the unchanged trace assertion MUST fail while the fixture, gateway and 200 control are all proven up |
| `scripts/cloud_ha_failover_smoke.sh` | D897: the gateway gets BOTH Eureka URLs but boots with an EMPTY upstream registry; after the primary is killed the upstream registers ONLY with the secondary, so a 200 through `lb://` can only come from real client failover |
| `scripts/falsify_cloud_ha_failover_smoke.sh` | D897: with only the dead primary URL given to the gateway, the same `lb://` assertion MUST fail while both registries, the gateway and the secondary's UP registration are proven live |
| `scripts/insight_breaker_config_smoke.sh` | D899: the actuator shows the tuned 60/40 thresholds on the SAME `PlatformHealthClienthealth` / `AiHealthClienthealth` breakers, and five driven calls make AI open on call 3 and platform on call 5 |
| `scripts/falsify_insight_breaker_config_smoke.sh` | D899: with both `minimumNumberOfCalls` raised to 10 the unchanged call-3 assertion MUST fail while the aligned names and 60/40 thresholds are still visible |
| `scripts/insight_metrics_smoke.sh` | D918: `resilience4j.circuitbreaker.calls`/`.state` read as real actuator meters for both Feign-method breaker names (`PlatformHealthClienthealth`/`AiHealthClienthealth`), with per-name COUNT > 0 after 12 driven calls |
| `scripts/falsify_insight_metrics_smoke.sh` | D918: the no-drive arm must keep the combined COUNT at 0 — a meter that counts code that never ran is not a meter |
| `scripts/events_service_smoke.sh` | D929: the events-service sidecar boots, connects to Redis, drains `nexus:events`, and registers as `NEXUS-EVENTS` with a throwaway Eureka — `/events/health` transitions to UP |
| `scripts/events_group_smoke.sh` | D931: two events-service readers share one Redis consumer group and drain N entries with `total_seen` summing to N; `/events/group` shows delivered+acked == N, pending 0 |
| `scripts/falsify_events_group_smoke.sh` | D931: the two readers in D929 tail mode double the sum to 2N, so the SPLIT assertion must redden — one flipped variable |
| `services/cloud/events-service/pom.xml` | D929: fifth Spring Cloud module |
| `services/cloud/events-service` | D929: fifth Spring Cloud module — bounded ring buffer drains `nexus:events`; `GET /events/health`, `GET /events/count`, `GET /events/recent`; port 19566 |
| `services/cloud/dispatcher-service/pom.xml` | D973: seventh Spring Cloud module (the sixth sidecar) — HMAC-signed outbound webhook dispatcher consuming `nexus:events` with per-hook circuit breaker, Redis DLQ and enqueue-side backoff; inert with an empty hook list |
| `services/cloud/dispatcher-service` | D973: see `scripts/check_dispatcher_service.mjs`; parent `services/cloud/pom.xml` lists `<module>dispatcher-service</module>` |
| `scripts/eureka_eviction_smoke.sh` | D919: fixture registered → SIGKILL → the registry stops listing it; the eviction is measured on this host, wall-clock, not assumed from the 30s lease |
| `scripts/falsify_eureka_eviction_smoke.sh` | D919: a heartbeat-keeping fixture stays listed through the window a dead one leaves — the kill was the signal |
| `scripts/insight_smoke.sh` | D885: with Eureka disabled, `/insight/plane` reports both upstreams `unavailable`, never a faked `UP` |
| `scripts/insight_registry_smoke.sh` | D886: with Eureka up, `NEXUS-INSIGHT` appears in `/eureka/apps` as `UP` with the plane's `instance-id` shape |
| `scripts/insight_feign_smoke.sh` | D887: two self-registered fixtures answer `lb://NEXUS-PLATFORM` / `lb://NEXUS-AI`; a runtime switch to a non-UP status is copied verbatim, and the fixtures' access logs prove the calls arrived |
| `scripts/insight_config_smoke.sh` | D889: a config-repo edit (v1 → v2) lands at `/insight/config` after `POST /actuator/refresh`, same pid, no restart |
| `scripts/insight_admin_smoke.sh` | D892: a clean `/instances` baseline, then the fifth member is visible UP in Spring Boot Admin; status read from THAT instance's `statusInfo` |
| `scripts/falsify_insight_admin_smoke.sh` | D892: boots the plane with insight deliberately absent and requires the admin smoke to FAIL while both servers are up |
| `scripts/insight_circuit_smoke.sh` | D895: after repeated upstream failures a Feign breaker's REAL actuator state is OPEN, while the plane view still says `unavailable` |
| `scripts/falsify_insight_circuit_smoke.sh` | D895: with the driving calls removed the "a breaker must be OPEN" assertion must FAIL |
| `scripts/eureka_ha_smoke.sh` | D894: explicit zones + non-self-registering nodes; registrations cross the wire in BOTH directions with `actionType=ADDED` |
| `scripts/falsify_eureka_ha_smoke.sh` | D894: with peer wiring removed the replication assertion must FAIL while both nodes are up |
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
"not claimed" paragraph; `docs/DECISIONS.md` holds 300 binding decisions. `docs/cloud_claims.yaml`
(D898) is the MACHINE-READABLE index of the cloud plane: every claim names its smoke, gate,
not-claimed boundary and an exact anchor in `docs/CLOUD.md`'s honesty section. The prose page
stays the human-facing one; `scripts/check_cloud_claims.mjs` keeps the two in sync.
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
