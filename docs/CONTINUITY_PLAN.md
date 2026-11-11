# NEXUS — Continuous Evolution Plan (post-D881)

**Owner:** this repository's autonomous development lane.
**Status:** active. This page is a plan, not a claim of completion: each item earns its own
`STATUS.md` section, its own gate and — where behaviour is claimed — its own smoke.

## Why this page exists

D870 already collected the last parallel lane (`stash@{0}` dispositioned, one branch, one tree). A
fresh census at D881 found: `git worktree list` = one entry (`master`), `git stash list` = empty,
`git branch -a` = `master` + `origin/master`, working tree clean, 1063 commits. So the "merge every
worktree into one main branch" instruction is **already satisfied** — there is no second lane to
merge, no locked content to take over, and nothing to wait for. Continuing means adding real work to
`master`, not re-doing a merge that already happened.

What *was* left unfinished was smaller and more concrete: three gates were red against correct code
or missing documentation, and the Spring Cloud plane was a four-module **sidecar** with no
service-to-service call and no distributed trace. Those are the seams this plan closes.

## The standing rules (unchanged, and load-bearing)

1. **Real data or nothing.** A price, rating, hour or distance traces to a `facts` row. Unverifiable
   is rendered as unverified. A service that cannot be reached is reported `unavailable`, never `UP`.
2. **No claim without a proof.** A gate is only real when a smoke proves the behaviour it reads. A
   new check that cannot be falsified is not a check.
3. **The ledger is the unit of work.** `docs/STATUS.md` gets one numbered section per unit, with a
   "not claimed" paragraph. `docs/CLOUD.md` is the one page for the cloud plane. `docs/API_CONTRACT.md`
   is authoritative for HTTP shapes.
4. **A new host coordinate** runs `scripts/check_cloud_plane_ports.mjs` first. A new registry member
   uses the same shape (`instance-id: name:port`, lease 5s/10s).
5. **Degrade honestly.** Model failure → deterministic search → human handoff. Upstream failure →
   labelled fallback. The site never goes dark and never invents an answer.

## Strategic direction: from sidecar to a cooperating service plane

The monolith stays a monolith (DECISIONS D2 / ROADMAP §169: no pervasive microservice rewrite). The
Spring Cloud elements grow **around** it, where they earn their keep: discovery, declarative
service-to-service calls, client-side load balancing, circuit breaking, distributed trace, one admin
window. Nothing here asks the platform to split its database or its transactions.

### Phase A — Close what was left open (D882)

| # | Unit | Acceptance |
|---|---|---|
| A1 | Re-aim `check_cloud_edge.mjs` E4 at D875's `@RequestMapping` + assert all five methods | gate PASS, stronger than the old grep |
| A2 | Document `GET /api/v1/cloud/info` (D872) in `API_CONTRACT.md` | `check_contract_drift.mjs` PASS, zero UNDOCUMENTED |
| A3 | Fix the real a11y defect in `reply-composer.tsx` (focus ring), and teach the reader the string form of `htmlFor`/`id` | `check_console_a11y.mjs` PASS, `tsc --noEmit` clean |
| A4 | Reconcile the ledger: D881 has a commit but no section | `check_ledger_sections.mjs` PASS |

### Phase B — Integration / one door (D883)

| # | Unit | Acceptance |
|---|---|---|
| B1 | `docs/ATLAS.md`: one map of modules, contracts, ports, gates, smokes, ledger | every path the atlas names exists |
| B2 | `scripts/check_atlas.mjs`: verify every cited path/anchor is real, and every gate has a runner | gate PASS + a falsifier that reddens on a broken citation |
| B3 | `scripts/verify_all.mjs`: one command for every read-only reader, with an honest verdict per row (PASS / UNCHECKED / TIMEOUT, never collapsed into "green") | gate PASS |

### Phase C — New Spring Cloud elements (D884, D885)

| # | Unit | Acceptance |
|---|---|---|
| C1 | **D884 W3C distributed trace**: `EdgeTracingFilter` mints/propagates `traceparent` at the gateway; FastAPI accepts and echoes `X-Trace-Id` | JUnit + pytest + `cloud_trace_smoke.sh` + static reader |
| C2 | **D885 `nexus-insight`**: a fifth, genuinely separate service — Eureka member, OpenFeign declarative calls to `NEXUS-PLATFORM` / `NEXUS-AI` via Spring Cloud LoadBalancer, resilience4j fallback that reports `unavailable` rather than faking health | Maven build + unit tests + `insight_smoke.sh` + static reader |
| C3 | Plane-wide reconciliation: port map, compose `cloud` profile, CI `cloud` job, `CLOUD.md`, `check_cloud_plane.mjs`, `README.md`, `ROADMAP.md`, `STATUS.md` | all readers PASS; one commit per unit |
| C4 | **D886 registry membership**: `insight_registry_smoke.sh` closes D885's largest "not claimed" gap by booting a throwaway Eureka and proving `NEXUS-INSIGHT` registers — plus `verify_all.mjs` stops reporting load-induced timeouts as verdicts | smoke PASS; full sweep 22 PASS / 0 FAIL / 2 UNCHECKED / 2 TIMEOUT, honestly reported |

### Phase D — Keep expanding (no terminal state)

Deliberately open-ended. Candidate seams, each to be re-judged against the plane at the time it is
picked up (none is promised here):

- **D858's HA Eureka**: two nodes were built but never converged because the replica resolver
  refuses to exclude a node from its own zone and this host's LAN address is unroutable from
  loopback. Re-approach with explicit availability zones, not by declaring victory.
  **→ closed by D894 (Phase F F3)**: explicit zones plus non-self-registering server nodes
  replicate registrations in both directions; the deployed plane still boots one node.
- **D853's Docker plane**: compose `cloud` profile is correct on paper; containers never left
  `Created` on the saturated daemon. Re-measure when the host has room.
- **Spring Cloud Bus / config broadcast**: needs a broker; currently every instance refreshes via
  its own `POST /actuator/refresh`. A bus is only worth adding with a measured second instance.
- **Trace export**: W3C propagation is not the same as a collector. An OTLP exporter is a separate,
  measured decision.
- **Reservation exclusion constraint** (`btree_gist`), **CJK recall measurement**, and the
  **real-provider eval lane** stay on `ROADMAP.md`'s open-questions list; they are product work, not
  cloud-plane work.
- **Citation/ledger readers that take minutes** on the 38k-line `STATUS.md` — D888 solved
  `check_citation_supports_sentence.mjs` (>900s → 4053ms) and D890 solved
  `check_line_cite_drift.mjs` (502s → 9.6s), both by replacing per-key `git show` spawns with one
  `git cat-file --batch`, and both with a byte-for-byte comparison against the old path. What still
  walks the corpus linearly (`check_ledger_citations.mjs` at ~22s, `check_status_citations.mjs`
  at ~13s) may deserve the same treatment; none is promised here.

### Phase E — the next three units (D887–D889), picked from the seams above

| # | Unit | Acceptance |
|---|---|---|
| E1 | **D887 Feign reaches a LIVE upstream.** D885/D886 left the load-bearing claim unproven: `@FeignClient(name=...)` resolving `lb://` to a registered instance. Two throwaway upstreams register themselves by name, insight boots LAST, and `/insight/plane` must report both rows `UP`/`upstream`; then one upstream switches to a non-`UP` status at runtime and the view must copy THAT value (nothing cached, nothing faked) | `insight_feign_smoke.sh` PASS, fixture access logs show both health paths requested, `CLOUD.md`'s honesty clause narrowed again |
| E2 | **D888 the slow reader becomes a tool.** `check_citation_supports_sentence.mjs` spawned `git show` once per citation (1316 of them, >900s). Replace with one `git ls-tree` + one `git cat-file --batch`, keep `--engine=legacy` verbatim, and prove byte-for-byte parity on a real ledger excerpt | full sweep measured in seconds, `verify_citation_engine_parity.mjs` PASS + self-falsifying, `verify_all.mjs` drops the 900s exemption |
| E3 | **D889 the fifth service joins the config plane.** Every other member imports the Config Server; `nexus-insight` did not. Add the optional config import, a `@RefreshScope` view of the resolved label, a config-repo entry and an `actuator/refresh` endpoint, then prove a repo edit lands WITHOUT a restart | `insight_config_smoke.sh` PASS (v1 -> repo rewrite -> refresh -> v2, same pid), `check_cloud_insight.mjs` extended |

| E4 | **D890 the last 500-second reader.** The D889 full sweep (9m23s) spent 8m22s in `check_line_cite_drift.mjs`, whose blob cache is keyed by (blame commit × cited file) and thus still spawned thousands of `git show` processes. Prefetch those keys through one `git cat-file --batch`, keep `--no-prefetch` for comparison | full census 9.6s, byte-identical output on a real ledger subset, `verify_all.mjs` SLOW set shrinks again |

Still open after Phase E, re-judged at pickup time (none promised): D858 HA Eureka with explicit zones (**closed by D894**), D853 Docker plane (**still open**), Spring Cloud Bus (needs a broker and a measured second instance), an OTLP exporter (propagation is not a collector), `btree_gist` reservation exclusion, CJK recall, the real-provider eval lane (**all still open**), and Spring Boot Admin listing the fifth member (**closed by D892**).

### Phase F — the next pickup list (ALL shipped: F1/D892, F2/D891, F3/D894, F4/D893)

Ordered by what the plane can prove next, not by date. Each is a seam a fresh session can start from
without re-doing a census of the repository.

| # | Unit | Acceptance |
|---|---|---|
| F1 | **The fifth member in the admin window.** D886/D887 both leave "Spring Boot Admin was not booted against this member" in `CLOUD.md`. Boot Admin + Eureka, register `nexus-insight`, and assert `/instances` lists it — **D892 shipped**: `scripts/insight_admin_smoke.sh` + `scripts/falsify_insight_admin_smoke.sh` | measured PASS: `admin lists NEXUS-INSIGHT UP, id=fdfed968ab3c` after a clean 0-member baseline; the absence arm FAILS with both servers up and the falsifier verifies the red is attributable; `CLOUD.md`'s not-claimed list narrowed again |
| F2 | **One shared blob reader.** D888 and D890 each implemented `ls-tree` + `cat-file --batch` parsing. Extract it into one `scripts/git_blobs.mjs` with both readers as callers — **D891 shipped**: `headTree` + `catFileBatch`, a self-falsifying `scripts/check_shared_blob_reader.mjs`, and a repeatable `scripts/verify_line_cite_parity.mjs` | both parity checks PASS byte-for-byte (citation stdout 2150 B identical, line-drift 4723 B / 2728 B identical, 0 drift), gate self-test reddens on three planted corruptions, no third copy of the parser |
| F3 | **HA Eureka, re-approached (D858).** Explicit availability zones and loopback-resolvable replica URLs, not the LAN address that was unroutable here — **D894 shipped**: `scripts/eureka_ha_smoke.sh` + `scripts/falsify_eureka_ha_smoke.sh` | two registrations crossed the wire in BOTH directions (`actionType=ADDED`, `status=UP`, own instanceIds), neither node logged an empty replica set; with peer wiring removed the same assertion FAILS while both JVMs are up. The deployed plane still boots ONE node — recorded, not declared a victory |
| F4 | **The remaining linear readers.** `check_ledger_citations.mjs` (~22s) and `check_status_citations.mjs` (~13s) still walk the 38k-line ledger — **D893 shipped**: the first became the THIRD caller of `scripts/git_blobs.mjs` (precise prefetch of only the HEAD blobs its own citations name), kept `--no-prefetch`, and gained `scripts/verify_ledger_cite_parity.mjs`; the second needed no change | measured `check_ledger_citations.mjs` **36605ms → 3355ms** with a byte-identical 3312-byte census, full-plane parity **21214ms vs 2010ms (10.6x)** and 0 drift; `check_status_citations.mjs` measured **1787ms** in the D892 sweep — the Phase F estimate of 13s was stale, and the walk is a filesystem scan, not a blob-spawn problem. Both now run under `verify_all.mjs`'s ordinary budget |

### Phase G — the next seams (G1/D895, G2/D896, G3/D897, G5/D898, G7/D899 shipped; the rest planned)

Phase F closed every item it named; this is not a terminal state. The plane now has discovery,
declarative `lb://` calls, honest fallback, config hot refresh, W3C propagation, an admin window
for the fifth member, and a MEASURED (but deliberately NOT deployed) HA pair. Ordered by what a
fresh session can prove next — none is promised, and each still earns its own gate, smoke and
"not claimed" paragraph:

| # | Unit | Acceptance |
|---|---|---|
| G1 | **The fifth service's breaker, measured.** D885 shipped resilience4j fallback but never showed its STATE — **D895 shipped**: `circuitbreakers` added to the actuator exposure, `scripts/insight_circuit_smoke.sh` + `scripts/falsify_insight_circuit_smoke.sh` | measured `baseline: 2 breaker(s), none open` → after 12 calls `{'AiHealthClienthealth': 'OPEN', 'PlatformHealthClienthealth': 'OPEN'}` while both plane rows stay `unavailable`/`fallback`; the no-drive arm FAILS with the process and actuator up. Metrics counters and recovery to CLOSED were NOT measured (see the not-claimed paragraph in CLOUD.md) |
| G2 | **Trace context survives degradation.** D884 propagates `traceparent` on successful hops; a breaker's 503 fallback should still echo the caller's `X-Trace-Id`, so an incident is correlatable — **D896 shipped**: `scripts/cloud_trace_fallback_smoke.sh`, `scripts/falsify_cloud_trace_fallback_smoke.sh`, `scripts/check_cloud_trace_fallback.mjs` | measured: ONE inbound `00-4bf92f...-00f067...-01` returned as `X-Trace-Id` on a 200, a 503 (`edge_upstream_unavailable`, `request_id` present) and a 429 (`edge_rate_limited`), each with a distinct child span; the no-degrade arm FAILS on `expected an honest 503 fallback` while fixture/gateway/200 control are proven up; the reader's 8 planted corruptions all redden. The `+1 < +10` filter ordering is asserted, not assumed |
| G3 | **Gateway failover across the HA pair.** D894 proved peer replication but no client used both registries — **D897 shipped**: `scripts/cloud_ha_failover_smoke.sh`, `scripts/falsify_cloud_ha_failover_smoke.sh`, `scripts/check_cloud_ha_failover.mjs` | measured: both registries EMPTY of `NEXUS-PLATFORM` at gateway boot → primary killed and confirmed dead → upstream registered ONLY with the secondary (`instanceId=nexus-platform:19121`) → a 200 through `lb://` whose body is the fixture's own `{"status":"UP","fixture":"NEXUS-PLATFORM"}` and whose `SERVE /api/v1/health` line proves arrival. With only the dead primary URL the SAME assertion FAILS while all processes are proven up. The empty-cache design rules out a stale DiscoveryClient false positive; 9 planted corruptions redden the reader |
| G4 | **Config broadcast (Spring Cloud Bus).** D889 refreshes ONE process manually. A bus needs a real broker; first MEASURE whether one is available on this host, then either prove a second instance rebinds from one broadcast or record the blocker | no claim of broadcast without a broker and two measured instances |
| G5 | **A machine-readable claim census.** `docs/CLOUD.md`'s honesty clauses are prose — **D898 shipped**: `docs/cloud_claims.yaml` + `scripts/check_cloud_claims.mjs` | measured: 16 claims, 21 smokes/falsifiers and 8 gates indexed; each record binds claim + smoke + gate + not_claimed + an EXACT honesty anchor in CLOUD.md; a reverse census requires every `check_*.mjs` / cloud `*.sh` named in CLOUD.md to be bound; 13 planted corruptions (missing smoke/gate/boundary, broken anchor, nonexistent script, duplicate id, malformed line, deleted CI/ATLAS/CLOUD entry, unbound smoke, empty census) all redden. The first self-test run also exposed a REAL reader defect — a `falsify_*` substring satisfying `includes(main_smoke)` — fixed with word-boundary matching and recorded in §898. The prose page stays the human-facing one |
| G6 | **OTLP export.** W3C propagation is not a collector. A span exporter is a separate, measured decision (sampling, storage, queryability) and is NOT implied by D884 | only after a collector is chosen and spans are actually queried |
| G7 | **Reconcile the breaker names D895 exposed** — **D899 shipped**: `services/cloud/insight-service/src/main/resources/application.yaml`, `scripts/insight_breaker_config_smoke.sh`, `scripts/falsify_insight_breaker_config_smoke.sh` | measured: instances renamed to the REAL Feign names with `minimumNumberOfCalls` 5 (platform) / 3 (AI) and visible `failureRateThreshold` 60 / 40; the actuator shows those values on the SAME instances, and five driven `/insight/plane` calls produce `AI OPEN` on call 3 and `platform OPEN` on call 5 with `bufferedCalls` tracking each. With both thresholds raised to 10 the unchanged call-3 assertion FAILS while the aligned names and 60/40 thresholds remain visible. A config edit that only looks right (old names, both on `default`) would open platform on call 3 and cannot pass |

Still open from earlier phases and deliberately NOT folded into G: `btree_gist` reservation exclusion,
CJK recall measurement, the real-provider eval lane, Docker verification (D853), and the three
ledger falsifier arms whose timeout-less spawn pattern makes them impractical on this host (D893).

### Phase H — the next seams (planned, not started)

Phase G closed five of its seven named seams. G4 (Spring Cloud Bus) and G6 (OTLP export) remain
open because they need infrastructure a throwaway smoke cannot invent: a real broker and a real
collector. H is ordered by what this host can prove WITHOUT either, and none of it is promised:

| # | Unit | Acceptance |
|---|---|---|
| H1 | **The fifth service joins the W3C trace plane.** D884 made the edge the only trace-id origin and the FastAPI service a participant, but `nexus-insight` — the one component that actually CALLS two other services — is still trace-blind. Add a strict participant filter plus a Feign `RequestInterceptor` so an inbound `traceparent` reaches BOTH `lb://` upstreams and is echoed even when the fallback answers | a wire-level smoke whose two live fixtures log the header they received, a degraded arm, and a falsifier arm that disables propagation; the service must still MINT nothing |
| H2 | **Eureka lease eviction, measured.** D894 explicitly left stale-replica eviction unmeasured. Register a fixture, kill it, and read `/eureka/apps` until the lease expires — or record the measured blocker | the instance disappears within the documented 5s/10s lease, with a no-eviction arm that reddens |
| H3 | **resilience4j Micrometer counters.** D895 and D899 both left "metrics counters NOT measured" open. Read `/actuator/metrics/resilience4j.circuitbreaker.calls` after D899's driven calls and compare with the actuator's `bufferedCalls` | the counter and the state agree on the SAME instance names, or a written reason why the meter is absent |
| H4 | **Bus / OTLP, only after measuring the infrastructure.** First ask whether a broker or collector is reachable on this host; if not, record the blocker rather than declaring a feature | no claim of broadcast without two instances, no claim of export without a queried span |
| H5 | **Docker plane, re-measured (D853).** Compose's `cloud` profile is correct on paper; the containers never left `Created` on a saturated daemon | containers actually run and answer, or a fresh host blocker is written down |

## Cadence

Every unit ends with: run its gate and smoke → append the numbered `STATUS.md` section with a
"not claimed" paragraph → `git add` / `git commit` on `master` → re-run the plane readers. No
short-lived branches, no stashes left behind: the tree stays unified. When a unit is blocked by the
host (Docker saturation, a missing DB, a port owned by another product), the unit records the
blocker in its "not claimed" paragraph and the plan moves to the next item — waiting is not a step.

## What this plan does NOT claim

That any Phase B/C/D/E item is shipped at the time this page is written (see `STATUS.md` for the
shipped ledger — §887–§889 record Phase E's measurements), that the Spring Cloud plane is production-ready (it is a dev sidecar with no auth
or TLS on its admin/eureka surface), or that the monolith has been decomposed. It also does not
claim a schedule: units are ordered by dependency, not by date.
