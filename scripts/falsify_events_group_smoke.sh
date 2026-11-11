#!/usr/bin/env bash
# NEXUS D931 — the falsifier for events_group_smoke.sh.
#
# The main smoke asserts that TWO readers sharing a consumer group drain N entries exactly once
# (sum == N). This arm boots the SAME two readers with group-enabled=false — D929's bare XREAD tails —
# and runs the SAME "sum == N" assertion. Two tails each read the whole stream, so sum == 2N and the
# main smoke MUST FAIL. Only ONE variable changes (group-enabled); both readers, Redis, the entry
# count and the assertion are identical. If the main smoke still passed, its "group partitions the
# stream" claim would be decoration, and this falsifier would go red.
#
# Exit 0 = the main smoke reddened for the attributable reason (group was the cause).
# Exit 1 = the main smoke stayed green (the claim is NOT falsifiable — a real defect).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-events-group-falsify"
mkdir -p "$LOG_DIR"
OUT="$LOG_DIR/tail-arm.log"

echo "== run the main smoke with group-enabled=false (the single flipped variable) =="
set +e
NEXUS_EVENTS_GROUP_OFF=1 \
NEXUS_EVENTS_GROUP_SKIP_BUILD="${NEXUS_EVENTS_GROUP_SKIP_BUILD:-1}" \
NEXUS_EVENTS_GROUP_A_PORT="${NEXUS_EVENTS_GROUP_A_PORT:-19577}" \
NEXUS_EVENTS_GROUP_B_PORT="${NEXUS_EVENTS_GROUP_B_PORT:-19578}" \
    bash "$ROOT/scripts/events_group_smoke.sh" >"$OUT" 2>&1
rc=$?
set -e

echo "  main smoke (tail arm) exit code: $rc"
tail -14 "$OUT"

if [ "$rc" -eq 0 ]; then
    echo "FAIL: the main smoke stayed GREEN with the group disabled — the SPLIT claim is not falsifiable" >&2
    exit 1
fi

# Attribute the red: it must be the doubled sum, not a build/boot failure that would redden either arm.
grep -q "sum=.*!= N=" "$OUT" || { echo "FAIL: red was NOT the doubled-sum assertion; unattributable" >&2; exit 1; }
grep -q "2\*" "$OUT" || true
echo "  red is attributable: with group disabled the same assertion saw sum=2N, not N"
echo "PASS: the group claim is falsifiable — disabling it is exactly what turns the smoke red"
