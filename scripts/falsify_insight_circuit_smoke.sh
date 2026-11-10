#!/usr/bin/env bash
# NEXUS D895 — the circuit-breaker smoke is falsifiable, not merely green with a running process.
#
#   It boots the SAME insight jar and performs ZERO driving calls, then runs the unchanged
#   "a breaker must be OPEN" assertion. Without the failures that are supposed to trip the breaker,
#   the arm MUST EXIT NON-ZERO. Its output must also show that the process was healthy, the
#   actuator endpoint was reachable, and the baseline had no open breaker — otherwise a red caused
#   by a dead JVM would be indistinguishable from a red caused by the missing cause.
#
# Usage:  bash scripts/falsify_insight_circuit_smoke.sh
# Env:    NEXUS_CIRCUIT_SKIP_BUILD=1 is set here; the insight jar must already be built.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-circuit-falsifier"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

echo "== no-drive arm: healthy process, actuator reachable, zero driving calls =="
output="$(NEXUS_CIRCUIT_SKIP_DRIVE=1 NEXUS_CIRCUIT_SKIP_BUILD=1 \
    NEXUS_CIRCUIT_PORT="${NEXUS_CIRCUIT_FALSIFY_PORT:-19562}" \
    bash "$ROOT/scripts/insight_circuit_smoke.sh" 2>&1)"
rc=$?
printf '%s\n' "$output" > "$LOG_DIR/falsifier.log"
printf '%s\n' "$output" | tail -14

[ "$rc" -ne 0 ] || fail "the no-drive arm PASSED — a breaker-state smoke green without any failures proves nothing"
for marker in \
    "insight up" \
    "/actuator/circuitbreakers reachable" \
    "baseline:" \
    "NO-DRIVE ARM" \
    "no breaker reached OPEN or HALF_OPEN"; do
    grep -qF "$marker" "$LOG_DIR/falsifier.log" \
        || fail "the no-drive arm failed for the wrong reason (missing marker: $marker)"
done

echo "PASS: insight circuit falsifier — with the driving calls removed the state assertion reddens"
