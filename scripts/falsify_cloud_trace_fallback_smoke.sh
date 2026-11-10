#!/usr/bin/env bash
# NEXUS D896 — the degraded-trace smoke is falsifiable, not merely green with a running gateway.
#
#   It boots the SAME fixture and the SAME gateway jar, but points the AI route at the HEALTHY
#   fixture so NO breaker fallback occurs. The unchanged "case B must be an honest 503 carrying
#   the caller's trace id" assertion MUST then exit non-zero. The arm is only meaningful if the
#   red is ATTRIBUTABLE: the output must prove the fixture and gateway came up, that case A
#   (the normal 200 control) still carried the caller's trace id, and that the failure is the
#   missing 503 fallback — not a dead JVM or a broken fixture.
#
# Usage:  bash scripts/falsify_cloud_trace_fallback_smoke.sh
# Env:    NEXUS_TRACE_FALLBACK_SKIP_BUILD=1 is set here; the gateway jar must already be built.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-cloud-trace-fallback-falsifier"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

echo "== no-degrade arm: healthy fixture, healthy gateway, zero breaker fallbacks =="
output="$(NEXUS_TRACE_FALLBACK_NO_DEGRADE=1 NEXUS_TRACE_FALLBACK_SKIP_BUILD=1 \
    NEXUS_TRACE_FALLBACK_GATEWAY_PORT="${NEXUS_TRACE_FALLBACK_FALSIFY_PORT:-18097}" \
    NEXUS_TRACE_FALLBACK_LIMIT_PORT="${NEXUS_TRACE_FALLBACK_FALSIFY_LIMIT_PORT:-18098}" \
    NEXUS_TRACE_FALLBACK_FIXTURE_PORT="${NEXUS_TRACE_FALLBACK_FALSIFY_FIXTURE_PORT:-18104}" \
    bash "$ROOT/scripts/cloud_trace_fallback_smoke.sh" 2>&1)"
rc=$?
printf '%s\n' "$output" > "$LOG_DIR/falsifier.log"
printf '%s\n' "$output" | tail -16

[ "$rc" -ne 0 ] || fail "the no-degrade arm PASSED — a 503-fallback trace claim green without any 503 proves nothing"
for marker in \
    "NO-DEGRADE ARM" \
    "fixture up on" \
    "gateway healthy on" \
    "case A (200) kept trace=" \
    "case A: normal 200 keeps the caller's trace id" \
    "expected an honest 503 fallback"; do
    grep -qF "$marker" "$LOG_DIR/falsifier.log" \
        || fail "the no-degrade arm failed for the wrong reason (missing marker: $marker)"
done
if grep -qF "FAIL: case A" "$LOG_DIR/falsifier.log"; then
    fail "case A (the healthy control) broke first, so the red is not attributable to the missing fallback"
fi

echo "PASS: cloud trace fallback falsifier — with the degradation removed the 503 trace assertion reddens"
