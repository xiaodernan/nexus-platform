#!/usr/bin/env bash
# NEXUS D900 — the W3C participation smoke is falsifiable, not merely green with a running plane.
#
#   It boots the SAME Eureka, the SAME two registered fixtures and the SAME insight jar, but
#   turns participation OFF with `--nexus.insight.trace.enabled=false`. The unchanged wire-level
#   assertions (response echoes the caller's X-Trace-Id; BOTH fixtures log the propagated child
#   context) MUST exit non-zero. Its output has to prove the red is ATTRIBUTABLE: the registry,
#   both fixtures and the 200 all_up=true plane view were all healthy when the trace assertion
#   failed — otherwise a dead JVM would be indistinguishable from missing propagation.
#
# Usage:  bash scripts/falsify_insight_trace_smoke.sh
# Env:    NEXUS_INSIGHT_TRACE_SKIP_BUILD=1 is set here; both jars must already be built.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-insight-trace-falsifier"
mkdir -p "$LOG_DIR"
fail() { echo "FAIL: $*" >&2; echo "logs: $LOG_DIR" >&2; exit 1; }

echo "== disabled-participation arm: healthy plane, trace propagation switched off =="
output="$(NEXUS_INSIGHT_TRACE_DISABLE=1 NEXUS_INSIGHT_TRACE_SKIP_BUILD=1 \
    NEXUS_INSIGHT_TRACE_EUREKA_PORT="${NEXUS_INSIGHT_TRACE_FALSIFY_EUREKA_PORT:-18767}" \
    NEXUS_INSIGHT_TRACE_PLATFORM_PORT="${NEXUS_INSIGHT_TRACE_FALSIFY_PLATFORM_PORT:-19133}" \
    NEXUS_INSIGHT_TRACE_AI_PORT="${NEXUS_INSIGHT_TRACE_FALSIFY_AI_PORT:-19134}" \
    NEXUS_INSIGHT_TRACE_PORT="${NEXUS_INSIGHT_TRACE_FALSIFY_PORT:-19569}" \
    NEXUS_INSIGHT_TRACE_DEGRADED_PORT="${NEXUS_INSIGHT_TRACE_FALSIFY_DEGRADED_PORT:-19570}" \
    bash "$ROOT/scripts/insight_trace_smoke.sh" 2>&1)"
rc=$?
printf '%s\n' "$output" > "$LOG_DIR/falsifier.log"
printf '%s\n' "$output" | tail -20

[ "$rc" -ne 0 ] || fail "the disabled-participation arm PASSED — a trace smoke green with propagation off proves nothing"
for marker in \
    "FALSIFIER ARM" \
    "Eureka up on" \
    "NEXUS-PLATFORM fixture on" \
    "NEXUS-AI fixture on" \
    "insight UP on" \
    "plane A: all_up=true, both rows UP" \
    "the response did not echo the caller's X-Trace-Id"; do
    grep -qF "$marker" "$LOG_DIR/falsifier.log" \
        || fail "the disabled arm failed for the wrong reason (missing marker: $marker)"
done

echo "PASS: insight trace falsifier — with participation off the wire-level trace assertion reddens"
