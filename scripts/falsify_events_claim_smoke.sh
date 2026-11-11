#!/usr/bin/env bash
# NEXUS D950 — the falsifier for events_claim_smoke.sh.
#
# The main smoke asserts that a live reader RECLAIMS N pending entries a dead consumer left stranded
# (reclaimed == N, PEL N -> 0). This arm runs the SAME compiled-from-source harness, but plants ONE
# corruption in a TEMP COPY of EventsReader.java: it removes the `reclaimDeadPending(me)` call from
# pollGroup(). Everything else — the real Lettuce XAUTOCLAIM method, the reader, Redis, the N entries,
# the dead-consumer strand, the assertion — is identical to the intact arm. With the third arm gone,
# D931's replay reads only the rescuer's OWN pending (nothing), so the dead consumer's N entries stay
# PENDING: reclaimed == 0 and PEL == N. The "PEL drained / reclaimed == N" assertion MUST go RED.
#
# Exit 0 = the main smoke reddened for the attributable reason (the reclaim arm was the cause).
# Exit 1 = the main smoke stayed green (the claim is NOT falsifiable — a real defect).
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${TMPDIR:-/tmp}/nexus-events-claim-falsify"
mkdir -p "$LOG_DIR"
OUT="$LOG_DIR/broken-arm.log"

echo "== run the main smoke with the reclaim arm removed (the single flipped variable) =="
set +e
NEXUS_EVENTS_CLAIM_OFF=1 \
NEXUS_EVENTS_CLAIM_N=6 \
    bash "$ROOT/scripts/events_claim_smoke.sh" >"$OUT" 2>&1
rc=$?
set -e

echo "  main smoke (reclaim-arm-removed) exit code: $rc"
tail -18 "$OUT"

if [ "$rc" -eq 0 ]; then
    echo "FAIL: the main smoke stayed GREEN with the reclaim arm removed — the recovery claim is not falsifiable" >&2
    exit 1
fi

# Attribute the red: it must be the RECOVERY assertion (reclaimed != N or PEL != 0), not a build,
# boot, or classpath failure that would redden either arm and prove nothing about XAUTOCLAIM.
grep -q "RECOVERY RED" "$OUT" || { echo "FAIL: red was NOT the RECOVERY assertion; unattributable" >&2; exit 1; }
echo "  red is attributable: with the reclaim arm removed the SAME assertion saw the PEL stay at N"
echo "PASS: the dead-consumer reclamation claim is falsifiable — removing the arm is exactly what turns it red"
