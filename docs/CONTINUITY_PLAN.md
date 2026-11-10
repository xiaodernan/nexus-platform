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
- **Citation/ledger readers that take minutes** on the 38k-line `STATUS.md`: a performance pass so
  `verify_all.mjs` is a tool a person will actually run.

## Cadence

Every unit ends with: run its gate and smoke → append the numbered `STATUS.md` section with a
"not claimed" paragraph → `git add` / `git commit` on `master` → re-run the plane readers. No
short-lived branches, no stashes left behind: the tree stays unified. When a unit is blocked by the
host (Docker saturation, a missing DB, a port owned by another product), the unit records the
blocker in its "not claimed" paragraph and the plan moves to the next item — waiting is not a step.

## What this plan does NOT claim

That any Phase B/C/D item is shipped at the time this page is written (see `STATUS.md` for the
shipped ledger), that the Spring Cloud plane is production-ready (it is a dev sidecar with no auth
or TLS on its admin/eureka surface), or that the monolith has been decomposed. It also does not
claim a schedule: units are ordered by dependency, not by date.
