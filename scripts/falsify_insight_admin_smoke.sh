#!/usr/bin/env bash
# NEXUS D892 — prove the admin smoke is falsifiable, not merely green with a live member.
#
#   It boots the SAME Eureka + Admin pair, deliberately leaves nexus-insight DOWN, and runs the
#   smoke's absence arm. The arm must EXIT NON-ZERO, and its output must show that both servers
#   came up and the /instances baseline was clean — otherwise a "red" caused by a dead Admin would
#   be indistinguishable from a red caused by the missing subject.
#
#   This is the arm that answers "what would this smoke do if the fifth member were not there?".
#   It does NOT prove the presence arm is green; scripts/insight_admin_smoke.sh does that by itself.
#
# Usage:  bash scripts/falsify_insight_admin_smoke.sh
# Env:    NEXUS_INSIGHT_ADMIN_* ports are inherited by the smoke; the jars must already be built
#         (CI builds them in the earlier cloud steps; locally set NEXUS_INSIGHT_ADMIN_SKIP_BUILD=0).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-admin-falsifier"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

echo "== absence arm: Eureka + Admin up, nexus-insight deliberately absent =="
# Separate coordinates from the presence smoke's, so a JVM that outlived its own cleanup cannot
# answer the absence arm's readiness probes and turn a missing-subject red into a false pass.
output="$(NEXUS_INSIGHT_ADMIN_ABSENT=1 NEXUS_INSIGHT_ADMIN_SKIP_BUILD=1 \
    NEXUS_INSIGHT_ADMIN_EUREKA_PORT="${NEXUS_INSIGHT_ADMIN_FALSIFY_EUREKA_PORT:-18765}" \
    NEXUS_INSIGHT_ADMIN_PORT="${NEXUS_INSIGHT_ADMIN_FALSIFY_ADMIN_PORT:-19453}" \
    bash "$ROOT/scripts/insight_admin_smoke.sh" 2>&1)"
rc=$?
printf '%s\n' "$output" > "$LOG_DIR/falsifier.log"
printf '%s\n' "$output" | tail -12

[ "$rc" -ne 0 ] || fail "the absence arm PASSED — a smoke that is green without its subject proves nothing"
for marker in \
    "eureka up" \
    "admin up" \
    "baseline: /instances has no NEXUS-INSIGHT" \
    "ABSENCE ARM" \
    "never surfaced NEXUS-INSIGHT as UP"; do
    grep -qF "$marker" "$LOG_DIR/falsifier.log" \
        || fail "the absence arm failed for the wrong reason (missing marker: $marker)"
done

echo "PASS: insight admin falsifier — the smoke reddens only when its subject is absent, with the servers up"
