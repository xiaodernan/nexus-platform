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

Still open after Phase E, re-judged at pickup time (none promised): D858 HA Eureka with explicit zones, D853 Docker plane, Spring Cloud Bus (needs a broker and a measured second instance), an OTLP exporter (propagation is not a collector), `btree_gist` reservation exclusion, CJK recall, the real-provider eval lane, and Spring Boot Admin listing the fifth member.

### Phase F — the next pickup list (F1/D892, F2/D891, F4/D893 shipped; F3 still open)

Ordered by what the plane can prove next, not by date. Each is a seam a fresh session can start from
without re-doing a census of the repository.

| # | Unit | Acceptance |
|---|---|---|
| F1 | **The fifth member in the admin window.** D886/D887 both leave "Spring Boot Admin was not booted against this member" in `CLOUD.md`. Boot Admin + Eureka, register `nexus-insight`, and assert `/instances` lists it — **D892 shipped**: `scripts/insight_admin_smoke.sh` + `scripts/falsify_insight_admin_smoke.sh` | measured PASS: `admin lists NEXUS-INSIGHT UP, id=fdfed968ab3c` after a clean 0-member baseline; the absence arm FAILS with both servers up and the falsifier verifies the red is attributable; `CLOUD.md`'s not-claimed list narrowed again |
| F2 | **One shared blob reader.** D888 and D890 each implemented `ls-tree` + `cat-file --batch` parsing. Extract it into one `scripts/git_blobs.mjs` with both readers as callers — **D891 shipped**: `headTree` + `catFileBatch`, a self-falsifying `scripts/check_shared_blob_reader.mjs`, and a repeatable `scripts/verify_line_cite_parity.mjs` | both parity checks PASS byte-for-byte (citation stdout 2150 B identical, line-drift 4723 B / 2728 B identical, 0 drift), gate self-test reddens on three planted corruptions, no third copy of the parser |
| F3 | **HA Eureka, re-approached (D858).** Explicit availability zones and loopback-resolvable replica URLs, not the LAN address that was unroutable here | two nodes actually replicate a registration, or a measured blocker recorded — never a declared victory |
| F4 | **The remaining linear readers.** `check_ledger_citations.mjs` (~22s) and `check_status_citations.mjs` (~13s) still walk the 38k-line ledger — **D893 shipped**: the first became the THIRD caller of `scripts/git_blobs.mjs` (precise prefetch of only the HEAD blobs its own citations name), kept `--no-prefetch`, and gained `scripts/verify_ledger_cite_parity.mjs`; the second needed no change | measured `check_ledger_citations.mjs` **36605ms → 3355ms** with a byte-identical 3312-byte census, full-plane parity **21214ms vs 2010ms (10.6x)** and 0 drift; `check_status_citations.mjs` measured **1787ms** in the D892 sweep — the Phase F estimate of 13s was stale, and the walk is a filesystem scan, not a blob-spawn problem. Both now run under `verify_all.mjs`'s ordinary budget |

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
