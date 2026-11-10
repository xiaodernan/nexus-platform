#!/usr/bin/env bash
# NEXUS D899 — the tuned-threshold smoke is falsifiable, not merely green with a running process.
#
#   It boots the SAME rebuilt jar with BOTH instances' minimumNumberOfCalls raised to 10 from the
#   command line. The actuator still shows the aligned names and the tuned failureRateThreshold
#   values, so the red cannot be blamed on a dead JVM or a name that never bound. The unchanged
#   "AI opens on call 3" assertion MUST exit non-zero, with markers proving the baseline, the
#   first two calls and the attributable failure reason.
#
# Usage:  bash scripts/falsify_insight_breaker_config_smoke.sh
# Env:    NEXUS_BREAKER_SKIP_BUILD=1 is set here; the rebuilt insight jar must already exist.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-breaker-config-falsifier"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

echo "== raised-threshold arm: same jar, both minimumNumberOfCalls set to 10 =="
output="$(NEXUS_BREAKER_FALSIFY=1 NEXUS_BREAKER_SKIP_BUILD=1 \
    NEXUS_BREAKER_PORT="${NEXUS_BREAKER_FALSIFY_PORT:-19565}" \
    bash "$ROOT/scripts/insight_breaker_config_smoke.sh" 2>&1)"
rc=$?
printf '%s\n' "$output" > "$LOG_DIR/falsifier.log"
printf '%s\n' "$output" | tail -18

[ "$rc" -ne 0 ] || fail "the raised-threshold arm PASSED — a threshold smoke green at 10 calls proves nothing about a threshold of 3"
for marker in \
    "FALSIFIER ARM" \
    "insight up on" \
    "actuator: aligned names" \
    "call 1:" \
    "call 2:" \
    "AI breaker did not open at its tuned minimumNumberOfCalls=3" \
    "breaker state did not follow the tuned thresholds at call 3"; do
    grep -qF "$marker" "$LOG_DIR/falsifier.log" \
        || fail "the raised-threshold arm failed for the wrong reason (missing marker: $marker)"
done

echo "PASS: insight breaker config falsifier — with the threshold raised the call-3 assertion reddens"
